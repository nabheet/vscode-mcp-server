/**
 * Port probing and Leader discovery.
 *
 * Before binding a port (or joining an existing Leader), a candidate probes
 * `GET /health` on the port. The four outcomes map to distinct actions:
 *
 *  - valid    → our service: join it as a Worker.
 *  - free     → nothing listening: try to promote to Leader.
 *  - foreign  → an unrelated app: increment the port and retry.
 *  - zombie   → occupied, no HTTP signature, but the IPC socket is alive:
 *               this is a frozen/starting Leader. Do NOT increment the port
 *               (that would fragment the cluster); retry registration.
 */
import * as http from "http";
import { HEALTH_SERVICE, PROBE_TIMEOUT_MS } from "./constants";
import { isIpcAlive } from "./ipc";

export type PortProbe =
  | { status: "valid" }
  | { status: "free" }
  | { status: "foreign" }
  | { status: "zombie" };

interface HealthResult {
  kind: "service" | "other" | "refused" | "timeout";
}

function getHealth(port: number): Promise<HealthResult> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/health", timeout: PROBE_TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let body: unknown = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          } catch {
            /* non-JSON body */
          }
          const service =
            typeof body === "object" && body !== null
              ? (body as Record<string, unknown>).service
              : undefined;
          resolve(service === HEALTH_SERVICE ? { kind: "service" } : { kind: "other" });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ kind: "timeout" });
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.code === "EADDRNOTAVAIL") {
        resolve({ kind: "refused" });
      } else {
        resolve({ kind: "timeout" });
      }
    });
  });
}

export async function probePort(port: number, ipcPath: string): Promise<PortProbe> {
  const health = await getHealth(port);
  switch (health.kind) {
    case "service":
      return { status: "valid" };
    case "refused":
      return { status: "free" };
    case "other":
      return { status: "foreign" };
    case "timeout": {
      // Occupied but silent. Could be an unrelated app that ignores /health
      // OR a frozen Leader. The IPC socket disambiguates.
      const alive = await isIpcAlive(ipcPath);
      return alive ? { status: "zombie" } : { status: "foreign" };
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Uniform jitter used for re-election backoff (0..maxMs). */
export function jitter(maxMs: number): number {
  return Math.floor(Math.random() * (maxMs + 1));
}
