// HTTP transport. Order of operations for every POST is fixed:
//   1. read RAW body (size-capped)
//   2. verify HMAC over the raw bytes — BEFORE any JSON parsing
//   3. parse JSON, route by `type`
//   4. serialize response ONCE, sign those exact bytes, send
// TLS is terminated by Caddy in front of this process (see deploy/).
import http from "node:http";
import { config } from "./config.js";
import { log, errMsg } from "./logger.js";
import { verifySignature, sign, SIGNATURE_HEADER, DEFAULT_SCHEME, type SignatureScheme } from "./hmac.js";
import { handleTask, failClosedFromRaw } from "./handler.js";

const PREFLIGHT_TYPE = "agent-games.preflight.v1";
const GATEKEEPER_TYPE = "agent-games.proof-gatekeeper.v1";

function send(res: http.ServerResponse, status: number, payload: unknown, scheme: SignatureScheme): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length),
    [SIGNATURE_HEADER]: sign(body, config.hmacSecret, scheme),
    "cache-control": "no-store",
  });
  res.end(body);
}

function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathOk = url.pathname === config.agentPath || url.pathname === config.agentPath + "/";

    // Health checks (unauthenticated, no task data). Signed anyway.
    if (req.method === "GET" && (url.pathname === "/health" || pathOk)) {
      return send(res, 200, { ok: true, protocolVersion: "v1" }, DEFAULT_SCHEME);
    }
    if (!pathOk) return send(res, 404, { error: "not_found" }, DEFAULT_SCHEME);
    if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" }, DEFAULT_SCHEME);
    if (!config.hmacSecret) return send(res, 503, { error: "secret_not_configured" }, DEFAULT_SCHEME);

    let raw: Buffer;
    try {
      raw = await readRaw(req, config.maxBodyBytes);
    } catch (e) {
      log.warn("body read failed", { err: errMsg(e) });
      return send(res, 413, { error: "body_too_large" }, DEFAULT_SCHEME);
    }

    // (2) Authenticate the raw bytes before touching JSON.
    const auth = verifySignature(raw, req.headers[SIGNATURE_HEADER], config.hmacSecret);
    if (!auth.ok || !auth.scheme) {
      // Header NAMES only (never values) to help diagnose signature format issues.
      log.warn("signature rejected", {
        reason: auth.reason,
        headerNames: Object.keys(req.headers),
        bodyBytes: raw.length,
      });
      return send(res, 401, { error: "invalid_signature" }, DEFAULT_SCHEME);
    }
    const scheme = auth.scheme;

    // (3) Parse only after authentication.
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      return send(res, 400, { error: "invalid_json" }, scheme);
    }
    const type = (msg as { type?: unknown })?.type;

    if (type === PREFLIGHT_TYPE) {
      log.info("preflight ok", { scheme, ms: Date.now() - started });
      return send(res, 200, { ok: true, protocolVersion: "v1" }, scheme);
    }

    if (type === GATEKEEPER_TYPE) {
      try {
        const out = await handleTask(msg);
        log.info("task answered", {
          task_id: (msg as { task_id?: string }).task_id,
          decision: out.decision,
          reason_code: out.reason_code,
          hasProof: Boolean(out.proof),
          ms: Date.now() - started,
        });
        return send(res, 200, out, scheme);
      } catch (e) {
        // Absolute last line of defence: never approve on error.
        log.error("task handler crashed — failing closed", { err: errMsg(e) });
        return send(res, 200, failClosedFromRaw(msg, "INTERNAL_ERROR"), scheme);
      }
    }

    log.warn("unknown message type", { type: typeof type === "string" ? type.slice(0, 80) : typeof type });
    return send(res, 400, { error: "unsupported_type" }, scheme);
  });
}
