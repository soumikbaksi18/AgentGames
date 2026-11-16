# MrBoltZ — Proof Gatekeeper agent (zkVerify Agent Games)

A TypeScript HTTPS agent for the [Proof Gatekeeper](https://agentgames.zkverify.io/events/proof-gatekeeper) event. For every signed transfer request it decides **APPROVE / REJECT** with deterministic code (no language model in the decision path) and returns a locally generated **Groth16 proof** of that decision.

## How it decides

The published `gatekeeper` circuit is the referee. Evaluating `gatekeeper.wasm` shows the circuit **asserts that the `decision` input equals its own evaluation**, so a wrong decision cannot produce a proof at all. [`src/policy.ts`](src/policy.ts) mirrors it exactly:

| Check (in order) | Fails → `reason_code` |
|---|---|
| `proof_vk == registered_vk` | `VK_SUBSTITUTION` |
| `public_balance >= minimum` | `THRESHOLD_MISMATCH` |
| `current_block < expiry_block` | `EXPIRED_CONDITION` |
| `recipient == condition_recipient` | `RECIPIENT_MISMATCH` |
| `amount <= max_transfer` | `AMOUNT_OVERFLOW` |
| all pass, `proof_tx` seen before in another task | `PROOF_REUSED` (no proof — excluded from proof scoring) |
| all pass | `APPROVE` / `VALID_CONDITION` |

Circuit public signals (output-then-public): `[commitment, registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock, currentBlock, recipient, conditionRecipient, amount, maxTransfer, decision, taskId]`; `salt` is the only private input.

## Request pipeline

1. Read the **raw** body (64 KB cap) → verify `x-agent-games-signature` (HMAC-SHA256) **before** parsing JSON → 401 on mismatch.
2. `agent-games.preflight.v1` → `{ ok: true, protocolVersion: "v1" }`, signed.
3. `agent-games.proof-gatekeeper.v1` → strict parse → idempotency cache (platform retries get the identical answer) → timestamp check → deadline budget (≤ 50 s, fail closed) → policy → seen-set → `snarkjs.groth16.fullProve` → local `verify` → signed `{ decision, reason_code, proof_tx, proof, public_signals }`.
4. In the background: submit the proof to zkVerify via Kurier and poll until **Finalized**; every status is written to `data/audit.jsonl`.

Any error, timeout, or policy/circuit disagreement → **REJECT** (fail closed).

## Layout

```
src/            config, logger (secret redaction), hmac, envelope, field, policy,
                store (seen-set / idempotency / audit), prover, kurier, handler, server
circuits/       gatekeeper.wasm, gatekeeper_final.zkey (from /build), verification_key.json
test/           unit tests (policy ⇄ circuit cross-check) + end-to-end replay harness
deploy/         systemd unit, Caddyfile (auto-TLS), deploy.sh, set-secret.sh
```

## Run & test

```bash
npm ci
npm test            # unit tests incl. circuit cross-check for every trap type
npm run harness     # end-to-end: signed envelopes over HTTP, proofs verified
cp .env.example .env && npm run dev
```

## Deploy (EC2 + Caddy)

```bash
SSH_KEY=~/.ssh/agentgames-gatekeeper.pem AGENT_IP=<ip> deploy/deploy.sh
# secrets: run in your own terminal — hidden prompt, written to the server only
SSH_KEY=... AGENT_IP=... deploy/set-secret.sh AGENT_GAMES_HMAC_SECRET
SSH_KEY=... AGENT_IP=... deploy/set-secret.sh KURIER_API_KEY
```

## Security

- Secrets only from env (`/etc/agentgames/agent.env`, root-only 600 on the server). Never in git, never logged (the logger redacts any loaded secret value).
- `.env` is git-ignored; `.env.example` ships blank.
- Fail closed everywhere; never approve by default.

## Open item

The platform does not document how the string `task_id` maps to the circuit's `taskId` field. Default is `sha256(utf8(task_id)) mod r` (`TASK_ID_ENCODING=sha256`), matching a peer agent whose Round 4 proofs verified; keccak proofs were rejected in competition. `keccak` and `hexdigits` remain available. Confirm on the first practice task whether proofs show as verified.
