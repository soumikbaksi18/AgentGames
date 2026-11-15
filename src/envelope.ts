// Strict parsing of the Proof Gatekeeper task envelope (schema from /build).
// Anything malformed throws; the handler turns that into a fail-closed REJECT.
import { FieldError, hexishToField, parseUint } from "./field.js";

export interface GatekeeperTask {
  type: "agent-games.proof-gatekeeper.v1";
  task_id: string;
  mode: string;
  issued_at: string;
  deadline_at: string;
  input: {
    registered_vk: string;
    proof_vk: string;
    minimum: string | number;
    public_balance: string | number;
    expiry_block: string | number;
    current_block: string | number;
    recipient: string;
    condition_recipient: string;
    amount: string | number;
    max_transfer: string | number;
    proof_tx: string;
  };
}

/** Field-encoded values, in the circuit's own terms. */
export interface ParsedInput {
  registeredVkHash: bigint;
  proofVkHash: bigint;
  minimum: bigint;
  publicBalance: bigint;
  expiryBlock: bigint;
  currentBlock: bigint;
  recipient: bigint;
  conditionRecipient: bigint;
  amount: bigint;
  maxTransfer: bigint;
}

export interface ParsedTask {
  taskId: string;
  mode: string;
  issuedAtMs: number | null;
  deadlineAtMs: number | null;
  proofTx: string;
  input: ParsedInput;
}

export class EnvelopeError extends Error {}

function parseTime(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v; // s or ms
  if (typeof v === "string" && v.length > 0) {
    if (/^\d+$/.test(v)) return parseTime(Number(v));
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export function parseTask(msg: unknown): ParsedTask {
  if (typeof msg !== "object" || msg === null) throw new EnvelopeError("envelope not an object");
  const m = msg as Record<string, unknown>;
  if (typeof m.task_id !== "string" || m.task_id.length === 0 || m.task_id.length > 200) {
    throw new EnvelopeError("task_id missing");
  }
  const inp = m.input as Record<string, unknown> | undefined;
  if (typeof inp !== "object" || inp === null) throw new EnvelopeError("input missing");
  if (typeof inp.proof_tx !== "string" || inp.proof_tx.trim().length === 0) {
    throw new EnvelopeError("proof_tx missing");
  }
  try {
    return {
      taskId: m.task_id,
      mode: typeof m.mode === "string" ? m.mode : "unknown",
      issuedAtMs: parseTime(m.issued_at),
      deadlineAtMs: parseTime(m.deadline_at),
      proofTx: inp.proof_tx.trim(),
      input: {
        registeredVkHash: hexishToField(inp.registered_vk, "registered_vk"),
        proofVkHash: hexishToField(inp.proof_vk, "proof_vk"),
        minimum: parseUint(inp.minimum, "minimum"),
        publicBalance: parseUint(inp.public_balance, "public_balance"),
        expiryBlock: parseUint(inp.expiry_block, "expiry_block"),
        currentBlock: parseUint(inp.current_block, "current_block"),
        recipient: hexishToField(inp.recipient, "recipient"),
        conditionRecipient: hexishToField(inp.condition_recipient, "condition_recipient"),
        amount: parseUint(inp.amount, "amount"),
        maxTransfer: parseUint(inp.max_transfer, "max_transfer"),
      },
    };
  } catch (e) {
    if (e instanceof FieldError) throw new EnvelopeError(e.message);
    throw e;
  }
}

/** Normalised key for the proof-reference seen-set (case-insensitive hex). */
export function proofRefKey(proofTx: string): string {
  const s = proofTx.trim();
  return /^0x[0-9a-fA-F]+$/.test(s) ? s.toLowerCase() : s;
}
