// Durable local state, as append-only JSONL files under DATA_DIR:
//   seen-proofs.jsonl  proof reference -> first task_id that used it
//   responses.jsonl    task_id -> exact response (idempotent retries)
//   audit.jsonl        every decision + proof + zkVerify status (disputes)
// Writes are synchronous so a crash cannot lose a "seen" mark that a
// response already depended on.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { log, errMsg } from "./logger.js";

const seen = new Map<string, string>(); // proofRefKey -> first task_id
const responses = new Map<string, unknown>(); // task_id -> response object

let dir = "";
const file = (name: string) => path.join(dir, name);

function loadJsonl(name: string, onRow: (row: Record<string, unknown>) => void): void {
  const f = file(name);
  if (!fs.existsSync(f)) return;
  const lines = fs.readFileSync(f, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      onRow(JSON.parse(line));
    } catch {
      log.warn("skipping corrupt state line", { file: name });
    }
  }
}

function append(name: string, row: unknown): void {
  fs.appendFileSync(file(name), JSON.stringify(row) + "\n", { mode: 0o600 });
}

export function initStore(dataDir = config.dataDir): void {
  dir = dataDir;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  seen.clear();
  responses.clear();
  loadJsonl("seen-proofs.jsonl", (r) => {
    if (typeof r.ref === "string" && typeof r.task_id === "string" && !seen.has(r.ref)) {
      seen.set(r.ref, r.task_id);
    }
  });
  loadJsonl("responses.jsonl", (r) => {
    if (typeof r.task_id === "string") responses.set(r.task_id, r.response);
  });
  log.info("state loaded", { seenProofs: seen.size, cachedResponses: responses.size, dir });
}

/**
 * Atomically (single-threaded JS, no await) check whether `ref` was already
 * used by a DIFFERENT task, and record it for this task if new.
 */
export function checkAndMarkProofRef(ref: string, taskId: string): { reused: boolean; firstTaskId?: string } {
  const first = seen.get(ref);
  if (first !== undefined) {
    return first === taskId ? { reused: false } : { reused: true, firstTaskId: first };
  }
  seen.set(ref, taskId);
  append("seen-proofs.jsonl", { ts: new Date().toISOString(), ref, task_id: taskId });
  return { reused: false };
}

export function getCachedResponse(taskId: string): unknown | undefined {
  return responses.get(taskId);
}

export function cacheResponse(taskId: string, response: unknown): void {
  responses.set(taskId, response);
  try {
    append("responses.jsonl", { ts: new Date().toISOString(), task_id: taskId, response });
  } catch (e) {
    log.error("failed to persist response", { err: errMsg(e) });
  }
}

export function audit(row: Record<string, unknown>): void {
  try {
    append("audit.jsonl", { ts: new Date().toISOString(), ...row });
  } catch (e) {
    log.error("failed to write audit", { err: errMsg(e) });
  }
}
