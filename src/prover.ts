// Local Groth16 proof generation (snarkjs) with the published gatekeeper
// artifacts. Every proof is verified locally against the verification key
// exported from the same zkey before it is returned.
//
// Public signal order (output-then-public, as snarkjs returns them):
//   [0] commitment (Poseidon output)   [1] registeredVkHash  [2] proofVkHash
//   [3] minimum   [4] publicBalance    [5] expiryBlock       [6] currentBlock
//   [7] recipient [8] conditionRecipient [9] amount          [10] maxTransfer
//   [11] decision (1 = APPROVE, 0 = REJECT)                  [12] taskId
// `salt` is the only private input.
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import * as snarkjs from "snarkjs";
import { config } from "./config.js";
import { FIELD_P } from "./field.js";
import type { ParsedInput } from "./envelope.js";

export interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

export interface ProofResult {
  proof: Groth16Proof;
  publicSignals: string[];
  ms: number;
}

export const DECISION_SIGNAL_INDEX = 11;
export const TASK_ID_SIGNAL_INDEX = 12;

let vkey: unknown;
function verificationKey(): unknown {
  if (!vkey) vkey = JSON.parse(fs.readFileSync(config.vkeyPath, "utf8"));
  return vkey;
}

export function assertArtifacts(): void {
  for (const p of [config.wasmPath, config.zkeyPath, config.vkeyPath]) {
    if (!fs.existsSync(p)) throw new Error(`missing circuit artifact: ${p}`);
  }
  verificationKey();
}

// --- tiny semaphore so a burst of tasks cannot exhaust a 1 GB box ---
let active = 0;
const waiters: Array<() => void> = [];
async function acquire(): Promise<void> {
  if (active < config.maxConcurrentProofs) {
    active++;
    return;
  }
  await new Promise<void>((r) => waiters.push(r));
  active++;
}
function release(): void {
  active--;
  waiters.shift()?.();
}

function randomSalt(): bigint {
  // 31 random bytes < 2^248 < p: uniformly hides the decision commitment.
  return BigInt("0x" + randomBytes(31).toString("hex")) % FIELD_P;
}

export class CircuitRejectedError extends Error {}

export async function prove(input: ParsedInput, taskIdField: bigint, approve: boolean): Promise<ProofResult> {
  const t0 = Date.now();
  const circuitInput = {
    registeredVkHash: input.registeredVkHash.toString(),
    proofVkHash: input.proofVkHash.toString(),
    minimum: input.minimum.toString(),
    publicBalance: input.publicBalance.toString(),
    expiryBlock: input.expiryBlock.toString(),
    currentBlock: input.currentBlock.toString(),
    recipient: input.recipient.toString(),
    conditionRecipient: input.conditionRecipient.toString(),
    amount: input.amount.toString(),
    maxTransfer: input.maxTransfer.toString(),
    decision: approve ? "1" : "0",
    salt: randomSalt().toString(),
    taskId: taskIdField.toString(),
  };

  await acquire();
  try {
    let out: { proof: Groth16Proof; publicSignals: string[] };
    try {
      out = await snarkjs.groth16.fullProve(circuitInput, config.wasmPath, config.zkeyPath);
    } catch (e) {
      // The circuit asserts decision == its own evaluation. A failure here means
      // our policy and the circuit disagree — the caller must fail closed.
      throw new CircuitRejectedError(`witness/proof failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
    const ok = await snarkjs.groth16.verify(verificationKey(), out.publicSignals, out.proof);
    if (!ok) throw new Error("locally generated proof failed local verification");
    if (out.publicSignals.length !== 13) throw new Error(`unexpected public signal count ${out.publicSignals.length}`);
    if (out.publicSignals[DECISION_SIGNAL_INDEX] !== (approve ? "1" : "0")) {
      throw new Error("decision public signal does not match decision");
    }
    return { proof: out.proof, publicSignals: out.publicSignals, ms: Date.now() - t0 };
  } finally {
    release();
  }
}

/** Warm the curve/wasm so the first real task is not slowed by setup. */
export async function warmUp(): Promise<number> {
  const t0 = Date.now();
  const sample: ParsedInput = {
    registeredVkHash: 1n, proofVkHash: 1n, minimum: 1n, publicBalance: 1n,
    expiryBlock: 2n, currentBlock: 1n, recipient: 1n, conditionRecipient: 1n,
    amount: 1n, maxTransfer: 1n,
  };
  await prove(sample, 1n, true);
  return Date.now() - t0;
}

/** Release snarkjs worker threads (tests / CLI tools; the server never calls it). */
export async function shutdownProver(): Promise<void> {
  const g = globalThis as { curve_bn128?: { terminate?: () => Promise<void> | void } };
  await g.curve_bn128?.terminate?.();
}
