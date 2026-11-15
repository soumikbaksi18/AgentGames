// HMAC-SHA256 over the RAW body bytes, header `x-agent-games-signature`.
//
// The platform docs specify the header and "HMAC over the raw body" but not
// the exact text encoding of the signature. We therefore accept the common
// encodings on inbound requests (hex / base64, optional "sha256=" prefix, and
// the secret used either as its UTF-8 string or as decoded hex bytes) and sign
// our response in the SAME scheme the platform just used. Every candidate is
// compared in constant time. Nothing about the secret is ever logged.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-agent-games-signature";

export type KeyMode = "utf8" | "hex";
export type Encoding = "hex" | "base64";

export interface SignatureScheme {
  keyMode: KeyMode;
  encoding: Encoding;
  prefix: "" | "sha256=";
}

/** Used when no inbound request has told us otherwise (e.g. GET health). */
export const DEFAULT_SCHEME: SignatureScheme = { keyMode: "utf8", encoding: "hex", prefix: "" };

function keyCandidates(secret: string): Array<[KeyMode, Buffer]> {
  const out: Array<[KeyMode, Buffer]> = [["utf8", Buffer.from(secret, "utf8")]];
  const hex = secret.startsWith("0x") ? secret.slice(2) : secret;
  if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0 && hex.length >= 32) {
    out.push(["hex", Buffer.from(hex, "hex")]);
  }
  return out;
}

function keyBytes(secret: string, mode: KeyMode): Buffer {
  const found = keyCandidates(secret).find(([m]) => m === mode);
  return (found ?? keyCandidates(secret)[0]!)[1];
}

function digest(key: Buffer, body: Buffer): Buffer {
  return createHmac("sha256", key).update(body).digest();
}

/** Decode a header value into raw digest bytes + the encoding it used. */
function decodeHeader(value: string): Array<{ bytes: Buffer; encoding: Encoding; prefix: "" | "sha256=" }> {
  let v = value.trim();
  let prefix: "" | "sha256=" = "";
  if (v.toLowerCase().startsWith("sha256=")) {
    prefix = "sha256=";
    v = v.slice(7);
  }
  const out: Array<{ bytes: Buffer; encoding: Encoding; prefix: "" | "sha256=" }> = [];
  if (/^[0-9a-fA-F]{64}$/.test(v)) out.push({ bytes: Buffer.from(v, "hex"), encoding: "hex", prefix });
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(v)) {
    const b = Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length === 32) out.push({ bytes: b, encoding: "base64", prefix });
  }
  return out;
}

export interface VerifyResult {
  ok: boolean;
  scheme?: SignatureScheme;
  reason?: "missing_header" | "malformed_header" | "mismatch" | "no_secret";
}

export function verifySignature(
  rawBody: Buffer,
  headerValue: string | string[] | undefined,
  secret: string,
): VerifyResult {
  if (!secret) return { ok: false, reason: "no_secret" };
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!value) return { ok: false, reason: "missing_header" };
  const provided = decodeHeader(value);
  if (provided.length === 0) return { ok: false, reason: "malformed_header" };

  let match: SignatureScheme | undefined;
  for (const [keyMode, key] of keyCandidates(secret)) {
    const expected = digest(key, rawBody);
    for (const p of provided) {
      // Evaluate every candidate (no early exit) to keep timing uniform.
      if (p.bytes.length === expected.length && timingSafeEqual(p.bytes, expected) && !match) {
        match = { keyMode, encoding: p.encoding, prefix: p.prefix };
      }
    }
  }
  return match ? { ok: true, scheme: match } : { ok: false, reason: "mismatch" };
}

export function sign(rawBody: Buffer | string, secret: string, scheme: SignatureScheme = DEFAULT_SCHEME): string {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const d = digest(keyBytes(secret, scheme.keyMode), body);
  return scheme.prefix + d.toString(scheme.encoding);
}
