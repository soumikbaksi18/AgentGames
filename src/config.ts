// Configuration is loaded ONLY from environment variables. Secrets are never
// hardcoded, never logged, and never sent anywhere except where they are used
// (HMAC key stays in-process; Kurier key goes only to the Kurier API).
import path from "node:path";

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v.trim();
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Env ${name} must be an integer`);
  }
  return n;
}

export type TaskIdEncoding = "keccak" | "sha256" | "hexdigits";
export type KurierNetwork = "testnet" | "mainnet";

const root = path.resolve(process.env.AGENT_ROOT ?? process.cwd());

export const config = {
  port: int("PORT", 8080),
  host: str("HOST", "127.0.0.1"),
  agentPath: str("AGENT_PATH", "/agent"),

  // --- secrets (env only) ---
  hmacSecret: str("AGENT_GAMES_HMAC_SECRET"),
  kurierApiKey: str("KURIER_API_KEY"),

  // --- deadlines ---
  // Platform hard deadline is 60s. We always answer well before it.
  hardDeadlineMs: int("HARD_DEADLINE_MS", 50_000),
  deadlineSafetyMs: int("DEADLINE_SAFETY_MS", 5_000),
  // Reject replays of tasks issued too long ago (signed but stale).
  maxTaskAgeMs: int("MAX_TASK_AGE_MS", 10 * 60_000),
  maxClockSkewMs: int("MAX_CLOCK_SKEW_MS", 2 * 60_000),
  maxBodyBytes: int("MAX_BODY_BYTES", 64 * 1024),

  // --- circuit ---
  wasmPath: path.join(root, "circuits", "gatekeeper.wasm"),
  zkeyPath: path.join(root, "circuits", "gatekeeper_final.zkey"),
  vkeyPath: path.join(root, "circuits", "verification_key.json"),
  // How the string task_id is mapped to the circuit's `taskId` field element.
  // Not documented by the platform — confirm with a practice task.
  taskIdEncoding: (str("TASK_ID_ENCODING", "keccak") as TaskIdEncoding),
  maxConcurrentProofs: int("MAX_CONCURRENT_PROOFS", 2),
  // "observe": only record whether proof_tx matches the task's own id.
  // "enforce": additionally treat a FOREIGN proof_tx as PROOF_REUSED.
  reuseHeuristic: (str("REUSE_HEURISTIC", "observe") as "observe" | "enforce"),

  // --- zkVerify via Kurier (optional; never blocks a response) ---
  kurierNetwork: (str("KURIER_NETWORK", "testnet") as KurierNetwork),
  kurierVkHash: str("KURIER_VK_HASH"),
  kurierPollMs: int("KURIER_POLL_MS", 5_000),
  kurierMaxWaitMs: int("KURIER_MAX_WAIT_MS", 15 * 60_000),

  // --- persistence ---
  dataDir: path.resolve(str("DATA_DIR", path.join(root, "data"))),

  logLevel: str("LOG_LEVEL", "info"),
} as const;

export function kurierBaseUrl(): string {
  return config.kurierNetwork === "mainnet"
    ? "https://api.kurier.xyz/api/v1"
    : "https://api-testnet.kurier.xyz/api/v1";
}

export function validateConfig(): void {
  if (!config.hmacSecret) {
    throw new Error(
      "AGENT_GAMES_HMAC_SECRET is not set. Use the plaintext from the dashboard 'Rotate Secret'.",
    );
  }
  if (!["keccak", "sha256", "hexdigits"].includes(config.taskIdEncoding)) {
    throw new Error("TASK_ID_ENCODING must be keccak | sha256 | hexdigits");
  }
  if (!["observe", "enforce"].includes(config.reuseHeuristic)) {
    throw new Error("REUSE_HEURISTIC must be observe | enforce");
  }
  if (!["testnet", "mainnet"].includes(config.kurierNetwork)) {
    throw new Error("KURIER_NETWORK must be testnet | mainnet");
  }
  if (!config.agentPath.startsWith("/")) {
    throw new Error("AGENT_PATH must start with '/'");
  }
}

/** Every secret value currently loaded — used by the logger to redact. */
export function secretValues(): string[] {
  return [config.hmacSecret, config.kurierApiKey].filter((s) => s.length >= 8);
}
