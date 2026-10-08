/**
 * Seamless cross-boundary host discovery (dev container ↔ host).
 *
 * A Docker dev container reaches its host leader through one of three
 * addresses, depending on the Docker platform:
 *
 *   1. `leaderHost`          — explicit user override (always wins).
 *   2. `host.docker.internal`— Docker Desktop (macOS/Windows): resolves to
 *                              the host loopback, zero config.
 *   3. default gateway       — Linux native Docker: the container's default
 *                              route gateway IS the host (the docker0 / bridge
 *                              interface IP). No extra_hosts or devcontainer
 *                              config needed.
 *
 * For the reverse direction (a host window joining a container leader), the
 * host leader must listen on the bridge address, not just loopback, so
 * containers can reach it at `<bridge-ip>:port`. This module also detects
 * those bridge addresses.
 *
 * Pure Node (no vscode API) so the whole discovery chain is unit-testable.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { CROSS_BOUNDARY_HOST_DEFAULT } from "./constants";

/**
 * Parse the default-route gateway out of a `/proc/net/route` listing.
 *
 * Each row is: `Iface Destination Gateway Flags ...`. The default route has
 * destination `00000000`; the gateway is a little-endian hex IPv4 (e.g.
 * `010011AC` → `172.17.0.1`). Returns null when there is no usable default
 * route (no default entry, or an on-link `0.0.0.0` gateway).
 */
export function parseProcNetRoute(content: string): string | null {
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("Iface")) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 3) continue;
    const [iface, destination, gatewayHex] = fields;
    if (!iface || destination !== "00000000") continue;
    const gateway = hexBeToIp(gatewayHex);
    if (!gateway) continue;
    return gateway;
  }
  return null;
}

/**
 * Convert a little-endian hex IPv4 (as stored in /proc/net/route, e.g.
 * `010011AC` → `172.17.0.1`) to a dotted-quad string, or null for the
 * on-link `0.0.0.0` / malformed input. The hex digits are the address bytes
 * in reverse (host byte order), so the byte pairs are emitted last-first.
 */
function hexBeToIp(hex: string): string | null {
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) return null;
  const bytes = [3, 2, 1, 0].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  const ip = bytes.join(".");
  return ip === "0.0.0.0" ? null : ip;
}

/**
 * Detect the default-route gateway for THIS process. Only meaningful inside
 * a container on Linux; on any other platform (and on hosts) returns null.
 *
 * `content` is injectable for tests; when omitted the real /proc/net/route
 * is read. Failures (file missing, unreadable, no default route) return
 * null rather than throwing — discovery is best-effort by design.
 */
export function detectDefaultGateway(content?: string): string | null {
  if (process.platform !== "linux") return null;
  let body: string;
  try {
    body = content ?? fs.readFileSync("/proc/net/route", "utf-8");
  } catch {
    return null;
  }
  return parseProcNetRoute(body);
}

/**
 * Ordered, deduplicated candidate chain for probing a leader in another
 * namespace: explicit override first, then the Docker Desktop default, then
 * the Linux default gateway (when detected).
 */
export function buildCrossBoundaryHosts(
  leaderHost: string | undefined,
  gateway: string | null,
): string[] {
  const out: string[] = [];
  for (const candidate of [leaderHost, CROSS_BOUNDARY_HOST_DEFAULT, gateway ?? undefined]) {
    if (candidate && !out.includes(candidate)) out.push(candidate);
  }
  return out;
}

/** Interface names Docker / Podman create for host↔container bridge networks. */
const BRIDGE_IFACE_RE = /^(docker0|br-[0-9a-f]{12}|cni-podman0|podman[0-9]+)$/i;

/**
 * Reduce an `os.networkInterfaces()` map to the IPv4 addresses of
 * docker-bridge-like interfaces. Pure and injectable so tests can pass
 * synthetic interface maps.
 */
export function filterBridgeAddresses(
  ifaces: Record<string, os.NetworkInterfaceInfo[] | undefined>,
): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!BRIDGE_IFACE_RE.test(name) || !addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !out.includes(addr.address)) out.push(addr.address);
    }
  }
  return out;
}

/**
 * Detect the host's Docker bridge addresses so a Linux host leader can bind
 * them and be reachable from containers at `<gateway>:port`. Only on Linux
 * (Docker Desktop for macOS/Windows forwards host.docker.internal to the
 * host loopback, so 127.0.0.1 alone is enough there). Best-effort: returns
 * [] on failure or when no bridge interfaces exist.
 *
 * `ifaces` is injectable for tests.
 */
export function detectBridgeAddresses(
  ifaces?: Record<string, os.NetworkInterfaceInfo[] | undefined>,
): string[] {
  if (process.platform !== "linux") return [];
  return filterBridgeAddresses(ifaces ?? os.networkInterfaces());
}

/**
 * The addresses a leader should bind, in order (primary first — the primary
 * is what gets logged and used for origin checks):
 *
 *  - the configured host — loopback by default; a container leader binds
 *    loopback too, because VS Code's port forwarding reaches it there;
 *  - plus any Docker bridge addresses on Linux, so containers can reach a
 *    host leader without config.
 *
 * Callers add a loopback bind when the configured host is a specific address
 * that does not already cover loopback (see extension.ts): sibling windows
 * probe loopback, so a leader bound only to one address would be invisible to
 * them and they would promote a second leader.
 */
export function buildBindHosts(host: string, bridges: string[]): string[] {
  const out: string[] = [];
  for (const candidate of [host, ...bridges]) {
    if (candidate && !out.includes(candidate)) out.push(candidate);
  }
  return out;
}

/**
 * True for a wildcard bind (`0.0.0.0`, `::`), which already accepts traffic on
 * every local address — loopback included — so no separate loopback bind is
 * needed (and adding one would collide with the wildcard bind).
 */
export function isWildcardHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return bare === "0.0.0.0" || bare === "::";
}
