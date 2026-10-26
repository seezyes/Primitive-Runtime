import { request as httpRequest } from "node:http";
import { CONTRACT_VERSION } from "../contracts.js";
import { CONTROL_VERSION } from "../version.js";
import { check, RuntimeError } from "../errors.js";
import { readPrivateJSON } from "../util.js";

export interface ClientConfig {
  socket_path: string;
  token: string;
}
export function loadClientConfig(path: string): ClientConfig {
  const v = readPrivateJSON(path) as ClientConfig;
  check(
    v &&
      typeof v.socket_path === "string" &&
      typeof v.token === "string" &&
      v.token.length >= 32,
    "CONFIG_REQUIRED",
    "Invalid IPC client configuration.",
  );
  return v;
}
export async function requestLocal(
  config: ClientConfig,
  path: "/tool" | "/control",
  body: unknown,
  timeoutMs = 15000,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: config.socket_path,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + config.token,
          "x-primitive-contract":
            path === "/tool" ? CONTRACT_VERSION : CONTROL_VERSION,
        },
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2097152) {
            req.destroy();
            reject(
              new RuntimeError(
                "RESPONSE_TOO_LARGE",
                "IPC response exceeds the limit.",
              ),
            );
          } else chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(
              new RuntimeError(
                "INVALID_RESPONSE",
                "Service returned invalid JSON.",
              ),
            );
          }
        });
        res.on("error", () =>
          reject(
            new RuntimeError(
              "SERVICE_UNAVAILABLE",
              "IPC response interrupted.",
              true,
            ),
          ),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () =>
      reject(
        new RuntimeError(
          "SERVICE_UNAVAILABLE",
          "Service is unavailable. Start primitive-runtime serve with the operator configuration. A client timeout does not cancel an accepted run.",
          true,
        ),
      ),
    );
    req.end(JSON.stringify(body));
  });
}
