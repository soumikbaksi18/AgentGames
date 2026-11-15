// Sample Proof Gatekeeper envelopes, one per trap variety documented on
// https://agentgames.zkverify.io/events/proof-gatekeeper (plus boundaries).
import { randomBytes } from "node:crypto";

export type Expected = { decision: "APPROVE" | "REJECT"; reason_code: string; provable: boolean };

const VK = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const OTHER_VK = "0x13a4c1f00d2b8f00aa11bb22cc33dd44ee55ff66778899aabbccddeeff0011aa";
const RECIPIENT = "0xDe42aB7c00000000000000000000000000009f01";

const hex = (n: number) => "0x" + randomBytes(n).toString("hex");

export function baseInput() {
  return {
    registered_vk: VK,
    proof_vk: VK,
    minimum: "1000",
    public_balance: "1460",
    expiry_block: 8430000,
    current_block: 8420000,
    recipient: RECIPIENT,
    condition_recipient: RECIPIENT,
    amount: "500",
    max_transfer: "1000",
    proof_tx: hex(32),
  };
}

export function envelope(input: Record<string, unknown>, taskId = "gk_" + randomBytes(3).toString("hex") + "_" + randomBytes(2).toString("hex")) {
  const now = Date.now();
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: taskId,
    mode: "practice",
    issued_at: new Date(now).toISOString(),
    deadline_at: new Date(now + 60_000).toISOString(),
    input,
  };
}

export interface Case {
  name: string;
  build: (prev: Map<string, ReturnType<typeof envelope>>) => ReturnType<typeof envelope>;
  expected: Expected;
}

export const CASES: Case[] = [
  { name: "VALID_CONDITION", build: () => envelope(baseInput()), expected: { decision: "APPROVE", reason_code: "VALID_CONDITION", provable: true } },
  { name: "VALID lowercase recipient", build: () => envelope({ ...baseInput(), condition_recipient: RECIPIENT.toLowerCase() }), expected: { decision: "APPROVE", reason_code: "VALID_CONDITION", provable: true } },
  { name: "VALID balance == minimum", build: () => envelope({ ...baseInput(), public_balance: "1000" }), expected: { decision: "APPROVE", reason_code: "VALID_CONDITION", provable: true } },
  { name: "VALID amount == cap", build: () => envelope({ ...baseInput(), amount: "1000" }), expected: { decision: "APPROVE", reason_code: "VALID_CONDITION", provable: true } },
  { name: "VK_SUBSTITUTION", build: () => envelope({ ...baseInput(), proof_vk: OTHER_VK }), expected: { decision: "REJECT", reason_code: "VK_SUBSTITUTION", provable: true } },
  { name: "THRESHOLD_MISMATCH", build: () => envelope({ ...baseInput(), public_balance: "999" }), expected: { decision: "REJECT", reason_code: "THRESHOLD_MISMATCH", provable: true } },
  { name: "EXPIRED_CONDITION", build: () => envelope({ ...baseInput(), current_block: 8430001 }), expected: { decision: "REJECT", reason_code: "EXPIRED_CONDITION", provable: true } },
  { name: "EXPIRED at exact block", build: () => envelope({ ...baseInput(), current_block: 8430000 }), expected: { decision: "REJECT", reason_code: "EXPIRED_CONDITION", provable: true } },
  { name: "RECIPIENT_MISMATCH", build: () => envelope({ ...baseInput(), condition_recipient: "0xDe42aB7c00000000000000000000000000009f02" }), expected: { decision: "REJECT", reason_code: "RECIPIENT_MISMATCH", provable: true } },
  { name: "AMOUNT_OVERFLOW", build: () => envelope({ ...baseInput(), amount: "1001" }), expected: { decision: "REJECT", reason_code: "AMOUNT_OVERFLOW", provable: true } },
  {
    name: "PROOF_REUSED",
    build: (prev) => envelope({ ...baseInput(), proof_tx: prev.get("VALID_CONDITION")!.input.proof_tx }),
    expected: { decision: "REJECT", reason_code: "PROOF_REUSED", provable: false },
  },
  { name: "malformed amount", build: () => envelope({ ...baseInput(), amount: "12.5" }), expected: { decision: "REJECT", reason_code: "INVALID_TASK", provable: false } },
];
