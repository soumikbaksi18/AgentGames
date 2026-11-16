// Encoding of task fields into BN254 scalar-field elements for the circuit.
//
// circom's witness calculator reduces every input mod p, so we do the same
// explicitly: our policy compares exactly the values the circuit compares.
import { createHash } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3";
import type { TaskIdEncoding } from "./config.js";

/** BN254 (alt_bn128) scalar field order r — pinned to ffjavascript's curve by a unit test. */
export const FIELD_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const mod = (x: bigint): bigint => ((x % FIELD_P) + FIELD_P) % FIELD_P;

export class FieldError extends Error {}

/** Non-negative integer given as a decimal string or a safe JS integer. */
export function parseUint(v: unknown, name: string): bigint {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) throw new FieldError(`${name} must be a non-negative integer`);
    return BigInt(v);
  }
  if (typeof v === "string" && /^(0|[1-9][0-9]{0,76})$/.test(v.trim())) return BigInt(v.trim());
  throw new FieldError(`${name} must be a non-negative integer`);
}

function bytesToBigint(b: Uint8Array): bigint {
  return BigInt("0x" + (Buffer.from(b).toString("hex") || "0"));
}

/** Arbitrary string -> field element via keccak256 (used for non-hex identifiers). */
export function stringToField(s: string): bigint {
  return mod(bytesToBigint(keccak_256(Buffer.from(s, "utf8"))));
}

/**
 * Hex identifier (VK hash, address, tx hash) -> field element.
 * A 0x-prefixed hex value is interpreted as a big-endian integer (mod p),
 * which is exactly what snarkjs/circom do with such inputs; so two spellings
 * of the same address that differ only in letter case encode identically.
 * Anything that is not clean hex falls back to keccak of its UTF-8 bytes.
 */
export function hexishToField(v: unknown, name: string): bigint {
  if (typeof v !== "string" || v.length === 0 || v.length > 200) {
    throw new FieldError(`${name} must be a non-empty string`);
  }
  const s = v.trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return mod(BigInt(s));
  return stringToField(s);
}

/** task_id string -> circuit `taskId`. Mapping is configurable (see config). */
export function taskIdToField(taskId: string, enc: TaskIdEncoding): bigint {
  switch (enc) {
    case "keccak":
      return stringToField(taskId);
    case "sha256":
      return mod(bytesToBigint(createHash("sha256").update(taskId, "utf8").digest()));
    case "hexdigits": {
      const hex = taskId.replace(/^gk_/i, "").replace(/[^0-9a-fA-F]/g, "");
      if (!hex) throw new FieldError("task_id has no hex digits");
      return mod(BigInt("0x" + hex));
    }
  }
}
