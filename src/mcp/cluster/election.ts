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

function getHealth(port: number, host = "127.0.0.1"): Promise<HealthResult> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/health", timeout: PROBE_TIMEOUT_MS }, (res) => {
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
    });
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

export async function probePort(
  port: number,
  ipcPath: string,
  host = "127.0.0.1",
): Promise<PortProbe> {
  const health = await getHealth(port, host);
  switch (health.kind) {
    case "service":
      return { status: "valid" };
    case "refused":
      return { status: "free" };
    case "other":
      return { status: "foreign" };
    case "timeout": {
      // Occupied but silent. Could be an unrelated app that ignores /health
      // OR a frozen Leader. The IPC socket disambiguates — but only when the
      // IPC path is reachable from THIS namespace (it is for a same-namespace
      // probe). Cross-boundary probes cannot use IPC; they call probeHost.
      const alive = await isIpcAlive(ipcPath);
      return alive ? { status: "zombie" } : { status: "foreign" };
    }
  }
}

export type HostProbe =
  | { status: "valid" }
  | { status: "free" }
  | { status: "foreign" }
  | { status: "timeout" };

/**
 * Probe /health on a specific host:port (used for cross-boundary discovery,
 * where the local IPC pipe is NOT shared and zombie disambiguation is
 * impossible). A timeout is reported distinctly: it may be a frozen Leader,
 * so the caller should retry the same port rather than promote or skip.
 */
export async function probeHost(port: number, host: string): Promise<HostProbe> {
  const health = await getHealth(port, host);
  switch (health.kind) {
    case "service":
      return { status: "valid" };
    case "refused":
      return { status: "free" };
    case "other":
      return { status: "foreign" };
    case "timeout":
      return { status: "timeout" };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Uniform jitter used for re-election backoff (0..maxMs). */
export function jitter(maxMs: number): number {
  return Math.floor(Math.random() * (maxMs + 1));
}
