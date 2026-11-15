import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySignature, sign } from "../src/hmac.js";
import { parseTask } from "../src/envelope.js";
import { evaluateConditions } from "../src/policy.js";
import { taskIdToField, hexishToField, FIELD_P } from "../src/field.js";
import { prove, CircuitRejectedError, DECISION_SIGNAL_INDEX, shutdownProver } from "../src/prover.js";
import { CASES, envelope } from "./fixtures.js";

const SECRET = "unit-test-secret-not-real-000000";

after(() => shutdownProver());

test("hmac: accepts hex, sha256= prefix and base64; rejects tampering", () => {
  const body = Buffer.from('{"type":"agent-games.preflight.v1","nonce":"n"}');
  const hex = createHmac("sha256", SECRET).update(body).digest("hex");
  const b64 = createHmac("sha256", SECRET).update(body).digest("base64");
  assert.equal(verifySignature(body, hex, SECRET).ok, true);
  assert.equal(verifySignature(body, "sha256=" + hex, SECRET).ok, true);
  assert.equal(verifySignature(body, b64, SECRET).ok, true);
  assert.equal(verifySignature(Buffer.from(body.toString() + " "), hex, SECRET).ok, false);
  assert.equal(verifySignature(body, undefined, SECRET).reason, "missing_header");
  assert.equal(verifySignature(body, "nope", SECRET).reason, "malformed_header");
  // Response signed in the scheme the request used.
  const scheme = verifySignature(body, "sha256=" + hex, SECRET).scheme!;
  assert.equal(sign(body, SECRET, scheme), "sha256=" + hex);
});

test("hmac: hex-looking secret also accepted as raw key bytes", () => {
  const secretHex = "ab".repeat(32);
  const body = Buffer.from("{}");
  const sig = createHmac("sha256", Buffer.from(secretHex, "hex")).update(body).digest("hex");
  const r = verifySignature(body, sig, secretHex);
  assert.equal(r.ok, true);
  assert.equal(r.scheme?.keyMode, "hex");
});

test("field: addresses compare case-insensitively, values reduced mod p", () => {
  assert.equal(hexishToField("0xDEADbeef", "x"), hexishToField("0xdeadBEEF", "x"));
  const big = hexishToField("0x" + "f".repeat(64), "x");
  assert.ok(big < FIELD_P);
  for (const enc of ["keccak", "sha256", "hexdigits"] as const) {
    assert.ok(taskIdToField("gk_24_9d1", enc) < FIELD_P);
  }
  assert.equal(taskIdToField("gk_24_9d1", "hexdigits"), 0x249d1n);
});

test("policy: every documented trap gets the documented decision + reason", () => {
  const prev = new Map<string, ReturnType<typeof envelope>>();
  for (const c of CASES) {
    const env = c.build(prev);
    prev.set(c.name, env);
    if (c.expected.reason_code === "PROOF_REUSED" || c.expected.reason_code === "INVALID_TASK") continue;
    const r = evaluateConditions(parseTask(env).input);
    assert.equal(r.approve ? "APPROVE" : "REJECT", c.expected.decision, c.name);
    assert.equal(r.reason, c.expected.reason_code, c.name);
  }
});

test("envelope: malformed numbers are refused", () => {
  const env = envelope({ ...CASES[0]!.build(new Map()).input, amount: "-5" });
  assert.throws(() => parseTask(env));
});

test("circuit agrees with policy on every case, and refuses the opposite decision", { timeout: 120_000 }, async () => {
  const prev = new Map<string, ReturnType<typeof envelope>>();
  for (const c of CASES) {
    const env = c.build(prev);
    prev.set(c.name, env);
    if (!c.expected.provable) continue;
    const t = parseTask(env);
    const pol = evaluateConditions(t.input);
    const tid = taskIdToField(t.taskId, "keccak");
    const out = await prove(t.input, tid, pol.approve);
    assert.equal(out.publicSignals[DECISION_SIGNAL_INDEX], pol.approve ? "1" : "0", c.name);
    await assert.rejects(prove(t.input, tid, !pol.approve), CircuitRejectedError, `${c.name}: circuit accepted wrong decision`);
  }
});
