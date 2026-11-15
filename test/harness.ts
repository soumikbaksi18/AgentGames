// End-to-end replay harness: signs sample envelopes exactly like the platform
// (HMAC over the raw body), POSTs them, and checks for each response:
//   - x-agent-games-signature is valid over the raw response body
//   - decision + reason_code match the documented trap outcome
//   - the Groth16 proof verifies against the circuit's verification key
//   - a retry of the same task_id returns the identical response
//
// Local (default): starts the agent in-process with a throwaway secret and a
// temp data dir:                     npm run harness
// Remote:  AGENT_URL=https://host/agent AGENT_GAMES_HMAC_SECRET=... npm run harness
//   (remote runs add synthetic proof refs to that agent's seen-set; use with care)
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import * as snarkjs from "snarkjs";
import { CASES, envelope } from "./fixtures.js";

const remote = process.env.AGENT_URL;
if (!remote) {
  process.env.AGENT_GAMES_HMAC_SECRET = "harness-" + randomBytes(16).toString("hex");
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeeper-harness-"));
  process.env.PORT = String(20000 + Math.floor(Math.random() * 20000));
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "warn";
}
const SECRET = process.env.AGENT_GAMES_HMAC_SECRET ?? "";
if (!SECRET) throw new Error("AGENT_GAMES_HMAC_SECRET required for remote runs");

const hmac = (b: string) => createHmac("sha256", SECRET).update(b).digest("hex");

async function post(url: string, obj: unknown) {
  const body = JSON.stringify(obj);
  const t0 = Date.now();
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-games-signature": hmac(body) },
    body,
  });
  const text = await r.text();
  const sigOk = r.headers.get("x-agent-games-signature") === hmac(text);
  return { status: r.status, text, json: JSON.parse(text), sigOk, ms: Date.now() - t0 };
}

async function main() {
  let url = remote ?? "";
  let stop: (() => Promise<void>) | undefined;
  if (!remote) {
    const { initStore } = await import("../src/store.js");
    const { createServer } = await import("../src/server.js");
    const { shutdownProver } = await import("../src/prover.js");
    initStore();
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(Number(process.env.PORT), "127.0.0.1", r));
    url = `http://127.0.0.1:${process.env.PORT}/agent`;
    stop = async () => {
      srv.close();
      await shutdownProver();
    };
  }
  const vkey = JSON.parse(fs.readFileSync(path.resolve("circuits/verification_key.json"), "utf8"));
  let failures = 0;
  const fail = (m: string) => {
    failures++;
    console.log("   ✗ " + m);
  };

  console.log(`Target: ${url}\n`);
  const pf = await post(url, { type: "agent-games.preflight.v1", agent_id: "agt_harness", issued_at: new Date().toISOString(), nonce: randomBytes(6).toString("hex") });
  console.log(`preflight  -> ${pf.status} ${pf.text} sig=${pf.sigOk ? "ok" : "BAD"}`);
  if (pf.status !== 200 || !pf.json.ok || pf.json.protocolVersion !== "v1" || !pf.sigOk) fail("preflight");

  const bad = await fetch(url, { method: "POST", headers: { "x-agent-games-signature": "00".repeat(32) }, body: "{}" });
  console.log(`bad sig    -> ${bad.status} (expect 401)`);
  if (bad.status !== 401) fail("bad signature not rejected");

  const prev = new Map<string, ReturnType<typeof envelope>>();
  for (const c of CASES) {
    const env = c.build(prev);
    prev.set(c.name, env);
    const r = await post(url, env);
    const j = r.json;
    let proofOk: boolean | "n/a" = "n/a";
    if (j.proof && j.public_signals) proofOk = await snarkjs.groth16.verify(vkey, j.public_signals, j.proof);
    console.log(`${c.name.padEnd(26)} -> ${j.decision} ${j.reason_code} proof=${proofOk} sig=${r.sigOk ? "ok" : "BAD"} ${r.ms}ms`);
    if (!r.sigOk) fail("response signature invalid");
    if (j.decision !== c.expected.decision) fail(`decision ${j.decision} != ${c.expected.decision}`);
    if (j.reason_code !== c.expected.reason_code) fail(`reason ${j.reason_code} != ${c.expected.reason_code}`);
    if (c.expected.provable && proofOk !== true) fail("expected a verifying proof");
    if (c.expected.provable && j.public_signals?.[11] !== (c.expected.decision === "APPROVE" ? "1" : "0")) fail("decision signal mismatch");
    if (c.expected.provable) {
      const again = await post(url, env);
      if (again.text !== r.text) fail("retry of same task_id returned a different response");
    }
  }

  await stop?.();
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
