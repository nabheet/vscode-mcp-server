/**
 * Low-level net.Server / net.Socket helpers for the cluster IPC pipe.
 * Kept free of the vscode API so the coordination layer is unit-testable
 * with real sockets.
 */

import * as fs from "fs";
import * as net from "net";
import { dirname } from "path";
import { IPC_CONNECT_TIMEOUT_MS } from "./constants";

export interface IpcConnection {
  socket: net.Socket;
  /** True when the remote end is a different process (vs a self-probe). */
}

/** Connect to the well-known IPC path with a hard timeout. Rejects on
 *  ECONNREFUSED / ENOENT (no leader listening) and on timeout. */
export function connectIpc(path: string, timeoutMs = IPC_CONNECT_TIMEOUT_MS): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`IPC connect to ${path} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });

    socket.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Best-effort liveness probe of the IPC path. Used to distinguish a frozen
 * Leader (socket exists and accepts connections at the kernel level even
 * while its event loop is blocked) from an unrelated app squatting on the
 * HTTP port. A successful connect is closed immediately.
 */
export function isIpcAlive(path: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (alive: boolean) => {
      if (done) return;
      done = true;
      resolve(alive);
    };

    connectIpc(path, timeoutMs).then(
      (socket) => {
        socket.destroy();
        finish(true);
      },
      () => finish(false),
    );
  });
}

/**
 * Remove a stale POSIX socket file left by a crashed Leader. Only unlinks
 * when the path exists AND is a socket (never a regular file). No-op on
 * Windows named pipes.
 */
export function unlinkStaleSocketFile(path: string): void {
  if (process.platform === "win32") return;
  try {
    const stat = fs.lstatSync(path);
    if (stat.isSocket()) {
      fs.unlinkSync(path);
    }
  } catch {
    /* already gone — fine */
  }
}

/**
 * Ensure the parent directory of a POSIX IPC socket exists (mode 0700) so the
 * socket can live in a dedicated subdirectory (`<dir>/<name>`) instead of as a
 * bare file in the tmp root. No-op on Windows named pipes, which have no
 * filesystem directory.
 */
export function ensureIpcDir(socketPath: string): void {
  if (process.platform === "win32") return;
  const dir = dirname(socketPath);
  if (!dir || dir === "." || dir === "/") return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode only applies at creation; a pre-existing dir with
  // looser perms (e.g. 0755 from a prior run or another tool) would
  // silently weaken the "private to the cluster" boundary. Enforce it.
  try {
    const st = fs.statSync(dir);
    if ((st.mode & 0o777) !== 0o700) {
      fs.chmodSync(dir, 0o700);
    }
  } catch {
    /* dir vanished in a race — bind will surface the real error */
  }
}

/**
 * Create an IPC server that listens on the well-known path. Handles the
 * stale-file race: first try binding; if the path exists but is dead,
 * unlink it and retry once. If the path is alive, the caller must treat the
 * port as occupied (another Leader holds it).
 *
 * Resolves with the listening server, or rejects with the original
 * EADDRINUSE-ish error when the path is owned by a live peer.
 */
export function createIpcServer(path: string): Promise<net.Server> {
  ensureIpcDir(path);
  const server = net.createServer();

  const listen = (): Promise<net.Server> =>
    new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve(server);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(path);
    });

  return listen().catch(async (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") throw err;
    if (process.platform === "win32") throw err; // named pipes: EADDRINUSE = live peer
    const alive = await isIpcAlive(path, 800);
    if (alive) throw err; // live (possibly frozen) Leader owns the path
    unlinkStaleSocketFile(path);
    return listen();
  });
}

/** Close an IPC server and destroy any remaining client sockets. */
export function closeIpcServer(server: net.Server, sockets: Set<net.Socket>): Promise<void> {
  for (const s of sockets) s.destroy();
  sockets.clear();
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    // Never let a lingering connection stall shutdown.
    server.unref?.();
  });
}
