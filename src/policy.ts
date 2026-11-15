// Deterministic gatekeeper policy. NO language model is involved anywhere in
// the decision path.
//
// The rules below mirror the gatekeeper circuit exactly. They were established
// by evaluating the published gatekeeper.wasm (the circuit asserts that the
// `decision` input equals its own evaluation, so a wrong decision cannot even
// produce a witness):
//
//   APPROVE (decision = 1) iff ALL of:
//     proofVkHash        == registeredVkHash      else VK_SUBSTITUTION
//     publicBalance      >= minimum               else THRESHOLD_MISMATCH
//     currentBlock       <  expiryBlock           else EXPIRED_CONDITION
//     recipient          == conditionRecipient    else RECIPIENT_MISMATCH
//     amount             <= maxTransfer           else AMOUNT_OVERFLOW
//
// PROOF_REUSED is outside the circuit: it is decided from the agent's
// persistent seen-set of proof references (see handler/store).
import type { ParsedInput } from "./envelope.js";

export type ReasonCode =
  | "VALID_CONDITION"
  | "VK_SUBSTITUTION"
  | "THRESHOLD_MISMATCH"
  | "EXPIRED_CONDITION"
  | "RECIPIENT_MISMATCH"
  | "AMOUNT_OVERFLOW"
  | "PROOF_REUSED";

export interface CheckResult {
  name: Exclude<ReasonCode, "VALID_CONDITION" | "PROOF_REUSED">;
  pass: boolean;
}

export interface PolicyResult {
  approve: boolean;
  reason: Exclude<ReasonCode, "PROOF_REUSED">;
  checks: CheckResult[];
}

/** Ordered: the first failing check supplies the reason code. */
export function evaluateConditions(i: ParsedInput): PolicyResult {
  const checks: CheckResult[] = [
    { name: "VK_SUBSTITUTION", pass: i.proofVkHash === i.registeredVkHash },
    { name: "THRESHOLD_MISMATCH", pass: i.publicBalance >= i.minimum },
    { name: "EXPIRED_CONDITION", pass: i.currentBlock < i.expiryBlock },
    { name: "RECIPIENT_MISMATCH", pass: i.recipient === i.conditionRecipient },
    { name: "AMOUNT_OVERFLOW", pass: i.amount <= i.maxTransfer },
  ];
  const firstFail = checks.find((c) => !c.pass);
  return firstFail
    ? { approve: false, reason: firstFail.name, checks }
    : { approve: true, reason: "VALID_CONDITION", checks };
}
