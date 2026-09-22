/**
 * WorkerCoordinator — a non-leader VS Code window.
 *
 * Responsibilities:
 *  - Connect to the Leader's IPC pipe and register this window's workspace.
 *  - Execute forwarded tool payloads locally (this process's vscode API).
 *  - Send a heartbeat (PING) and watch for PONG; two missed PONGs mean the
 *    Leader's event loop is frozen, so force-close the socket and trigger
 *    re-election.
 *  - On IPC close/error, immediately trigger re-election.
 *
 * Pure Node (no vscode API); workspace identity, executor, and the
 * re-election callback are injected by extension.ts.
 */
import type * as net from "node:net";
import type { JsonRpcResponse } from "../../utils/types";
import { BusyError, type ToolExecutor } from "../executor";
import {
  getIpcPath,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISS_LIMIT,
  MSG,
  REGISTER_TIMEOUT_MS,
} from "./constants";
import { connectIpc } from "./ipc";
import { createDecoder, encodeMessage, type IpcMessage, type WindowState } from "./protocol";

export interface WorkerOptions {
  ipcPath?: string;
  connectTimeoutMs?: number;
  executor: ToolExecutor;
  workspaceId: string;
  workspacePaths: string[];
  displayName: string;
  /** Stable per-window UUID surfaced in REGISTER → leader's list_workspaces. */
  instanceId?: string;
  instanceName?: string;
  /** Initial window state (active file / open editors) for list_workspaces. */
  state?: WindowState;
  log?: (msg: string) => void;
}

export class WorkerCoordinator {
  readonly role = "worker" as const;
  private readonly opts: WorkerOptions;
  private readonly ipcPath: string;
  private lostLeaderHandler: (reason: string) => void = () => {};
  private socket: net.Socket | null = null;
  private stopped = false;
  private registered = false;
  private state: WindowState = { openEditors: [] };
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPongAt = 0;
  private missedPongs = 0;
  private welcomeResolve: (() => void) | null = null;
  private welcomeReject: ((err: Error) => void) | null = null;

  constructor(opts: WorkerOptions) {
    this.opts = opts;
    this.ipcPath = opts.ipcPath ?? getIpcPath();
    if (opts.state) this.state = opts.state;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.registered = false;
    this.missedPongs = 0;

    const socket = await connectIpc(this.ipcPath, this.opts.connectTimeoutMs);
    if (this.stopped) {
      socket.destroy();
      throw new Error("Worker stopped while connecting");
    }
    this.socket = socket;
    this.lastPongAt = Date.now();
    socket.setNoDelay(true);

    const decode = createDecoder((msg) => this.onMessage(msg));
    socket.on("data", (chunk: Buffer) => {
      try {
        decode(chunk);
      } catch {
        this.failOver("corrupt IPC frame from leader");
      }
    });
    socket.on("close", () => this.failOver("IPC socket closed"));
    socket.on("error", () => this.failOver("IPC socket error"));

    // Register with the Leader and wait for WELCOME.
    const welcome = new Promise<void>((resolve, reject) => {
      this.welcomeResolve = resolve;
      this.welcomeReject = reject;
    });
    socket.write(
      encodeMessage({
        type: MSG.REGISTER,
        id: this.opts.workspaceId,
        workspacePaths: this.opts.workspacePaths,
        displayName: this.opts.displayName,
        instanceId: this.opts.instanceId,
        instanceName: this.opts.instanceName,
        state: this.state,
      }),
    );
    await Promise.race([
      welcome,
      new Promise<never>((_, reject) => {
        const t = setTimeout(
          () => reject(new Error("WELCOME from leader timed out")),
          REGISTER_TIMEOUT_MS,
        );
        (t as NodeJS.Timeout).unref?.();
      }),
    ]).catch((err: Error) => {
      this.failOver(`registration failed: ${err.message}`);
      throw err;
    });
    this.registered = true;

    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
    this.opts.log?.(
      `[worker] registered with leader on ${this.ipcPath} as ${this.opts.displayName}`,
    );
  }

  /** Wire re-election. Called by the cluster owner after every election. */
  setOnLostLeader(handler: (reason: string) => void): void {
    this.lostLeaderHandler = handler;
  }

  /**
   * Publish a window-state change (active file / open editors) to the
   * Leader. Before registration the value is only stored locally — it is
   * carried in the REGISTER payload so the Leader never sees a window
   * without state. After REGISTERED, each call sends MSG.UPDATE over IPC.
   */
  updateState(state: WindowState): void {
    this.state = state;
    if (!this.registered || !this.socket || this.socket.destroyed) return;
    try {
      this.socket.write(encodeMessage({ type: MSG.UPDATE, state }));
    } catch {
      this.failOver("UPDATE write failed");
    }
  }

  async stop(timeoutMs = 3000): Promise<void> {
    this.stopped = true;
    this.rejectWelcome(new Error("Worker stopped"));
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) {
      socket.destroy();
      await Promise.race([
        new Promise<void>((resolve) => socket.once("close", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
      ]);
    }
  }

  private heartbeatTick(): void {
    if (this.stopped || !this.socket || this.socket.destroyed) return;
    try {
      this.socket.write(encodeMessage({ type: MSG.PING }));
    } catch {
      this.failOver("PING write failed");
      return;
    }
    if (Date.now() - this.lastPongAt > HEARTBEAT_INTERVAL_MS) {
      this.missedPongs++;
      if (this.missedPongs >= HEARTBEAT_MISS_LIMIT) {
        this.failOver(
          `no PONG for ${this.missedPongs} heartbeat intervals — leader event loop assumed frozen`,
        );
      }
    } else {
      this.missedPongs = 0;
    }
  }

  private onMessage(msg: IpcMessage): void {
    if (this.stopped) return;
    switch (msg.type) {
      case MSG.WELCOME:
        this.resolveWelcome();
        break;
      case MSG.PONG:
        this.lastPongAt = Date.now();
        this.missedPongs = 0;
        break;
      case MSG.CALL: {
        const callId = typeof msg.callId === "string" ? msg.callId : undefined;
        const rawBody = typeof msg.rawBody === "string" ? msg.rawBody : undefined;
        if (callId && rawBody) {
          void this.handleCall(callId, rawBody);
        }
        break;
      }
      default:
        break;
    }
  }

  /** Execute a forwarded tool payload and ship the result back. */
  private async handleCall(callId: string, rawBody: string): Promise<void> {
    let response: JsonRpcResponse;
    try {
      response = await this.opts.executor.dispatch(rawBody);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = err instanceof BusyError ? -32050 : -32603;
      response = { jsonrpc: "2.0", id: extractRequestId(rawBody), error: { code, message: msg } };
    }
    if (this.stopped || !this.socket || this.socket.destroyed) return;
    try {
      this.socket.write(encodeMessage({ type: MSG.RESULT, callId, response }));
    } catch {
      this.failOver("RESULT write failed");
    }
  }

  private failOver(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.rejectWelcome(new Error(reason));
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
    this.opts.log?.(`[worker] lost leader: ${reason}`);
    this.lostLeaderHandler(reason);
  }

  private resolveWelcome(): void {
    this.welcomeResolve?.();
    this.welcomeResolve = null;
    this.welcomeReject = null;
  }

  private rejectWelcome(err: Error): void {
    this.welcomeReject?.(err);
    this.welcomeResolve = null;
    this.welcomeReject = null;
  }
}

function extractRequestId(rawBody: string): number | string | null {
  try {
    return (JSON.parse(rawBody) as { id?: number | string | null }).id ?? null;
  } catch {
    return null;
  }
}
