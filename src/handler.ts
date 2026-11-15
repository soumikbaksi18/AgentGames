// Task orchestration. Every path that is not a clean, proven decision ends in
// REJECT (fail closed). Order:
//   parse -> idempotency -> timestamp -> deadline budget -> policy
//   -> proof-reference seen-set -> Groth16 proof (+ local verify) -> respond
//   -> background zkVerify submission (never blocks the response)
import { config } from "./config.js";
import { log, errMsg } from "./logger.js";
import { parseTask, proofRefKey, EnvelopeError, type ParsedTask } from "./envelope.js";
import { evaluateConditions } from "./policy.js";
import { taskIdToField } from "./field.js";
import { prove, CircuitRejectedError, type Groth16Proof } from "./prover.js";
import { checkAndMarkProofRef, getCachedResponse, cacheResponse, audit } from "./store.js";
import { submitInBackground } from "./kurier.js";

export interface TaskResponse {
  decision: "APPROVE" | "REJECT";
  reason_code: string;
  proof_tx?: string;
  proof?: Groth16Proof;
  public_signals?: string[];
}

export function failClosedFromRaw(msg: unknown, reason: string): TaskResponse {
  const proofTx = (msg as { input?: { proof_tx?: unknown } })?.input?.proof_tx;
  return {
    decision: "REJECT",
    reason_code: reason,
    ...(typeof proofTx === "string" ? { proof_tx: proofTx } : {}),
  };
}

const inFlight = new Map<string, Promise<TaskResponse>>();

export async function handleTask(msg: unknown): Promise<TaskResponse> {
  let task: ParsedTask;
  try {
    task = parseTask(msg);
  } catch (e) {
    const reason = e instanceof EnvelopeError ? "INVALID_TASK" : "INTERNAL_ERROR";
    log.warn("task rejected at parse", { err: errMsg(e) });
    return failClosedFromRaw(msg, reason);
  }

  // Idempotency: platform retries must get the byte-identical decision, and a
  // retry must never be mistaken for a reused proof reference.
  const cached = getCachedResponse(task.taskId) as TaskResponse | undefined;
  if (cached) {
    log.info("idempotent replay", { task_id: task.taskId });
    return cached;
  }
  const running = inFlight.get(task.taskId);
  if (running) return running;

  const p = decideWithDeadline(task, msg).then((resp) => {
    cacheResponse(task.taskId, resp);
    return resp;
  });
  inFlight.set(task.taskId, p);
  try {
    return await p;
  } finally {
    inFlight.delete(task.taskId);
  }
}

async function decideWithDeadline(task: ParsedTask, raw: unknown): Promise<TaskResponse> {
  const now = Date.now();

  // Timestamp validity (the body is already HMAC-authenticated).
  if (task.issuedAtMs !== null) {
    if (now - task.issuedAtMs > config.maxTaskAgeMs || task.issuedAtMs - now > config.maxClockSkewMs) {
      log.warn("stale or future-dated task", { task_id: task.taskId, issued_at_ms: task.issuedAtMs, now });
      const r = failClosedFromRaw(raw, "STALE_TASK");
      audit({ kind: "decision", task_id: task.taskId, mode: task.mode, proof_tx: task.proofTx, ...r });
      return r;
    }
  }

  let budget = config.hardDeadlineMs;
  if (task.deadlineAtMs !== null) budget = Math.min(budget, task.deadlineAtMs - now - config.deadlineSafetyMs);
  budget = Math.max(budget, 1_000);

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<TaskResponse>((resolve) => {
    timer = setTimeout(() => {
      log.error("task deadline hit — failing closed", { task_id: task.taskId, budget });
      resolve(failClosedFromRaw(raw, "TIMEOUT_FAIL_CLOSED"));
    }, budget);
  });
  try {
    return await Promise.race([decide(task), timeout]);
  } catch (e) {
    log.error("decision error — failing closed", { task_id: task.taskId, err: errMsg(e) });
    return failClosedFromRaw(raw, "INTERNAL_ERROR");
  } finally {
    clearTimeout(timer);
  }
}

async function decide(task: ParsedTask): Promise<TaskResponse> {
  const policy = evaluateConditions(task.input);

  // Record every proof reference we see. Reuse only matters when all field
  // checks pass: a field-level trap is still provably rejected by the circuit.
  const reuse = checkAndMarkProofRef(proofRefKey(task.proofTx), task.taskId);

  const base = { task_id: task.taskId, mode: task.mode, proof_tx: task.proofTx, checks: policy.checks };

  if (policy.approve && reuse.reused) {
    // Not provable: the circuit would only accept decision=1 for these fields.
    // The platform excludes PROOF_REUSED tasks from proof scoring.
    const r: TaskResponse = { decision: "REJECT", reason_code: "PROOF_REUSED", proof_tx: task.proofTx };
    audit({ kind: "decision", ...base, first_task_id: reuse.firstTaskId, decision: r.decision, reason_code: r.reason_code });
    return r;
  }

  const decision = policy.approve ? "APPROVE" : "REJECT";
  let taskIdField: bigint;
  try {
    taskIdField = taskIdToField(task.taskId, config.taskIdEncoding);
  } catch (e) {
    throw new Error(`task_id encoding failed: ${errMsg(e)}`);
  }

  let proofOut;
  try {
    proofOut = await prove(task.input, taskIdField, policy.approve);
  } catch (e) {
    const reason = e instanceof CircuitRejectedError ? "POLICY_CIRCUIT_MISMATCH" : "INTERNAL_ERROR";
    log.error("proof generation failed — failing closed", { task_id: task.taskId, reason, err: errMsg(e) });
    const r: TaskResponse = { decision: "REJECT", reason_code: reason, proof_tx: task.proofTx };
    audit({ kind: "decision", ...base, policy_decision: decision, decision: r.decision, reason_code: reason, err: errMsg(e) });
    return r;
  }

  const r: TaskResponse = {
    decision,
    reason_code: policy.reason,
    proof_tx: task.proofTx,
    proof: proofOut.proof,
    public_signals: proofOut.publicSignals,
  };
  audit({
    kind: "decision",
    ...base,
    decision,
    reason_code: policy.reason,
    task_id_encoding: config.taskIdEncoding,
    prove_ms: proofOut.ms,
    proof: proofOut.proof,
    public_signals: proofOut.publicSignals,
  });
  submitInBackground(task.taskId, proofOut.proof, proofOut.publicSignals);
  return r;
}
