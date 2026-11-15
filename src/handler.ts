// Task handler. STAGE 1: fail-closed stub — every task is REJECTed until the
// deterministic gatekeeper policy + prover are wired in (next commit).
export interface TaskResponse {
  decision: "APPROVE" | "REJECT";
  reason_code: string;
  proof_tx?: string;
  proof?: unknown;
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

export async function handleTask(msg: unknown): Promise<TaskResponse> {
  return failClosedFromRaw(msg, "AGENT_NOT_READY");
}
