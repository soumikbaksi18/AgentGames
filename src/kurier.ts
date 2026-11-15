// zkVerify submission via Kurier REST. Runs in the BACKGROUND after the
// response is sent: the platform re-verifies our proof offline against its own
// VK, so on-chain confirmation is an audit trail, not part of the decision.
// A proof is only treated as "confirmed" once Kurier reports Finalized.
import fs from "node:fs";
import path from "node:path";
import { config, kurierBaseUrl } from "./config.js";
import { log, errMsg } from "./logger.js";
import { audit } from "./store.js";
import type { Groth16Proof } from "./prover.js";

/** vk_hash the platform registered on zkVerify MAINNET (/api/circuit-info). */
export const PLATFORM_MAINNET_VK_HASH =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";

const TERMINAL_OK = new Set(["Finalized", "Aggregated", "AggregationPublished"]);
const TERMINAL_FAIL = new Set(["Failed"]);

export function kurierEnabled(): boolean {
  return config.kurierApiKey.length > 0;
}

// Never interpolate the key into anything that gets logged.
const endpoint = (p: string) => `${kurierBaseUrl()}/${p}/${config.kurierApiKey}`;

async function postJson(p: string, body: unknown, timeoutMs = 20_000): Promise<{ status: number; json: any }> {
  const r = await fetch(endpoint(p), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json: any = null;
  try {
    json = await r.json();
  } catch {
    /* non-JSON */
  }
  return { status: r.status, json };
}

let vkHashPromise: Promise<string> | null = null;

function findVkHash(j: any): string | undefined {
  const c = j?.vkHash ?? j?.meta?.vkHash ?? j?.data?.vkHash;
  return typeof c === "string" && c.startsWith("0x") ? c : undefined;
}

async function resolveVkHash(): Promise<string> {
  if (config.kurierVkHash) return config.kurierVkHash;
  if (config.kurierNetwork === "mainnet") return PLATFORM_MAINNET_VK_HASH;
  // Testnet: register our exported VK once and cache the hash on disk.
  const cacheFile = path.join(config.dataDir, `kurier-vk-${config.kurierNetwork}.json`);
  if (fs.existsSync(cacheFile)) {
    const cached = findVkHash(JSON.parse(fs.readFileSync(cacheFile, "utf8")));
    if (cached) return cached;
  }
  const vk = JSON.parse(fs.readFileSync(config.vkeyPath, "utf8"));
  const { status, json } = await postJson("register-vk", {
    proofType: "groth16",
    proofOptions: { library: "snarkjs", curve: "bn128" },
    vk,
  });
  const hash = findVkHash(json);
  if (!hash) throw new Error(`register-vk failed (HTTP ${status}): ${JSON.stringify(json)?.slice(0, 300)}`);
  fs.writeFileSync(cacheFile, JSON.stringify({ vkHash: hash, network: config.kurierNetwork }), { mode: 0o600 });
  log.info("kurier vk registered", { network: config.kurierNetwork, vkHash: hash });
  return hash;
}

function vkHash(): Promise<string> {
  if (!vkHashPromise) {
    vkHashPromise = resolveVkHash().catch((e) => {
      vkHashPromise = null; // allow retry on next proof
      throw e;
    });
  }
  return vkHashPromise;
}

/** Fire-and-forget. Never throws; outcome goes to the audit log. */
export function submitInBackground(taskId: string, proof: Groth16Proof, publicSignals: string[]): void {
  if (!kurierEnabled()) return;
  void (async () => {
    try {
      const hash = await vkHash();
      const { status, json } = await postJson("submit-proof", {
        proofType: "groth16",
        vkRegistered: true,
        proofOptions: { library: "snarkjs", curve: "bn128" },
        proofData: { proof, publicSignals, vk: hash },
      });
      const jobId: string | undefined = json?.jobId;
      if (!jobId) throw new Error(`submit-proof failed (HTTP ${status}): ${JSON.stringify(json)?.slice(0, 300)}`);
      audit({ kind: "kurier", task_id: taskId, network: config.kurierNetwork, jobId, status: "Submitted", optimisticVerify: json?.optimisticVerify });

      const deadline = Date.now() + config.kurierMaxWaitMs;
      let last = "";
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, config.kurierPollMs));
        const r = await fetch(`${kurierBaseUrl()}/job-status/${config.kurierApiKey}/${encodeURIComponent(jobId)}`, {
          signal: AbortSignal.timeout(15_000),
        });
        const j: any = await r.json().catch(() => null);
        const st: string = j?.status ?? "Unknown";
        if (st !== last) {
          last = st;
          audit({ kind: "kurier", task_id: taskId, jobId, status: st, txHash: j?.txHash, blockHash: j?.blockHash });
          log.info("kurier status", { task_id: taskId, jobId, status: st, txHash: j?.txHash });
        }
        if (TERMINAL_OK.has(st)) return; // confirmed
        if (TERMINAL_FAIL.has(st)) return;
      }
      audit({ kind: "kurier", task_id: taskId, jobId, status: "PollTimeout", lastStatus: last });
    } catch (e) {
      log.warn("kurier submission failed", { task_id: taskId, err: errMsg(e) });
      audit({ kind: "kurier", task_id: taskId, status: "Error", err: errMsg(e) });
    }
  })();
}
