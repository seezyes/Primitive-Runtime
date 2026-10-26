import { createServer, type Server } from "node:http";
import { createConnection } from "node:net";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { Configuration } from "./config.js";
import { RuntimeService } from "../service.js";
import { CONTROL_VERSION } from "../version.js";
import { CONTRACT_VERSION } from "../contracts.js";
import { check, RuntimeError, safeError } from "../errors.js";
import { privateDirectory } from "../util.js";
import type { Actor } from "../types.js";
import { acquireStateLock } from "./state-lock.js";
export { requestLocal, loadClientConfig, type ClientConfig } from "./client.js";
async function socketLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const finish = (v: boolean) => {
      socket.destroy();
      resolve(v);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(true));
  });
}
export async function serve(configFile: string): Promise<{
  service: RuntimeService;
  server: Server;
  close: () => Promise<void>;
  closed: Promise<void>;
}> {
  const configuration = new Configuration(configFile);
  const config = configuration.current;
  privateDirectory(config.state_dir);
  const releaseLock = acquireStateLock(config.state_dir);
  let service: RuntimeService | undefined;
  let server: Server | undefined;
  try {
    if (process.platform !== "win32") {
      check(
        config.socket_path.startsWith(config.state_dir + "/"),
        "CONFIG_REQUIRED",
        "Unix socket must be inside the private state directory.",
      );
      if (existsSync(config.socket_path)) {
        check(
          lstatSync(config.socket_path).isSocket(),
          "CONFIG_REQUIRED",
          "Socket path is occupied by a non-socket file.",
        );
        check(
          !(await socketLive(config.socket_path)),
          "SERVICE_RUNNING",
          "A service is already listening.",
        );
        unlinkSync(config.socket_path);
      }
    }
    service = new RuntimeService(configuration);
    const runtime = service;
    await runtime.initialize();
    // Recovery and initial retention must succeed before a listener can admit
    // requests. Otherwise a failed start could release ownership behind a live
    // socket and allow another service to open the same state.
    await runtime.retention();
    const listener = createServer(async (req, res) => {
      const reply = (payload: unknown, status = 200) => {
        if (res.destroyed) return;
        res.writeHead(status, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(payload));
      };
      try {
        check(
          req.method === "POST" &&
            (req.url === "/tool" || req.url === "/control"),
          "INVALID_ARGUMENT",
          "Unknown IPC operation.",
        );
        check(
          !req.headers.origin,
          "ACCESS_DENIED",
          "Browser origins are not accepted on operator IPC.",
        );
        const control = req.url === "/control";
        check(
          req.headers["x-primitive-contract"] ===
            (control ? CONTROL_VERSION : CONTRACT_VERSION),
          "INCOMPATIBLE_CONTRACT",
          "IPC application contract mismatch.",
        );
        const auth = req.headers.authorization;
        check(
          typeof auth === "string" &&
            auth.startsWith("Bearer ") &&
            auth.length <= 20000,
          "ACCESS_DENIED",
          "Authentication required.",
        );
        const actor = configuration.authenticate(auth.slice(7), control);
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          check(bytes <= 1048576, "INVALID_ARGUMENT", "IPC request too large.");
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = control
          ? await runtime.control(body)
          : await runtime.action(actor as Actor, body);
        reply(result);
      } catch (error) {
        reply(
          {
            contract_version: CONTRACT_VERSION,
            ok: false,
            error: safeError(error),
          },
          error instanceof RuntimeError && error.code === "ACCESS_DENIED"
            ? 403
            : 400,
        );
      }
    });
    server = listener;
    listener.requestTimeout = 10000;
    listener.headersTimeout = 5000;
    listener.keepAliveTimeout = 1000;
    listener.maxConnections = 64;
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(
        { path: config.socket_path, readableAll: false, writableAll: false },
        () => {
          listener.off("error", reject);
          resolve();
        },
      );
    });
    if (process.platform !== "win32") chmodSync(config.socket_path, 0o600);
    let closing = false;
    let closedResolve!: () => void;
    const closed = new Promise<void>((r) => {
      closedResolve = r;
    });
    const retention = setInterval(
      () => void runtime.retention().catch(() => {}),
      3600000,
    );
    retention.unref();
    const close = async () => {
      if (closing) return closed;
      closing = true;
      clearInterval(retention);
      await runtime.close();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      releaseLock();
      closedResolve();
    };
    runtime.onStop = () => {
      void close().catch((error) => {
        process.stderr.write(
          `Primitive Runtime shutdown failed: ${safeError(error).code}\n`,
        );
      });
    };
    return { service: runtime, server: listener, close, closed };
  } catch (error) {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (service) await service.close();
    releaseLock();
    throw error;
  }
}
