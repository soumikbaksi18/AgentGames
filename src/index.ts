import { config, validateConfig } from "./config.js";
import { log, errMsg } from "./logger.js";
import { createServer } from "./server.js";

try {
  validateConfig();
} catch (e) {
  if (!config.hmacSecret) {
    // Start anyway so health checks pass before "Rotate Secret"; every POST is
    // refused with 503 until the secret is set (fail closed).
    log.warn("AGENT_GAMES_HMAC_SECRET not set — serving health only, refusing all POSTs");
  } else {
    log.error("config invalid — refusing to start", { err: errMsg(e) });
    process.exit(1);
  }
}

const server = createServer();
// Keep-alive outlives typical client reuse. The 60s task deadline itself is
// enforced inside the task handler (fail closed), not by these socket timers.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 58_000;

server.listen(config.port, config.host, () => {
  log.info("agent listening", { host: config.host, port: config.port, path: config.agentPath });
});

function shutdown(sig: string): void {
  log.info("shutting down", { sig });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (e) => log.error("unhandledRejection", { err: errMsg(e) }));
