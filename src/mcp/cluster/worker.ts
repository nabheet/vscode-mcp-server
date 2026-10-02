/**
 * WorkerCoordinator — a non-leader VS Code window.
 *
 * Responsibilities:
 *  - Connect to the Leader over the HTTP member channel and register this
 *    window's workspace.
 *  - Execute forwarded tool payloads locally (this process's vscode API).
 *  - Send a heartbeat (PING) and watch for PONG; two missed PONGs mean the
 *    Leader's event loop is frozen, so tear the transport down and trigger
 *    re-election.
 *  - On transport close/error, immediately trigger re-election.
 *
 * The coordinator talks to the Leader purely over the HTTP member channel
 * (SSE receive leg + POST send leg) on the Leader's single port. Pure Node
 * (no vscode API); workspace identity, executor, and the re-election
 * callback are injected by extension.ts.
 */
import type { JsonRpcResponse } from "../../utils/types";
import { BusyError, type ToolExecutor } from "../executor";
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_MISS_LIMIT, MSG, REGISTER_TIMEOUT_MS } from "./constants";
import type { MemberTransport } from "./memberTransport";
import type { IpcMessage, WindowState } from "./protocol";

export interface WorkerOptions {
  /** The transport to the Leader (HTTP member channel). */
  transport: MemberTransport;
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
  private lostLeaderHandler: (reason: string) => void = () => {};
  private transport: MemberTransport | null = null;
  private stopped = false;
  private registered = false;
  private state: WindowState = { openEditors: [] };
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pingOutstanding = false;
  private missedPongs = 0;
  private welcomeResolve: (() => void) | null = null;
  private welcomeReject: ((err: Error) => void) | null = null;

  constructor(opts: WorkerOptions) {
    this.opts = opts;
    if (opts.state) this.state = opts.state;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.registered = false;
    this.missedPongs = 0;
    this.pingOutstanding = false;

    const transport = this.opts.transport;
    transport.onMessage = (msg) => this.onMessage(msg);
    transport.onClose = (reason) => this.failOver(reason);
    await transport.connect();
    if (this.stopped) {
      transport.close();
      throw new Error("Worker stopped while connecting");
    }
    this.transport = transport;

    // Register with the Leader and wait for WELCOME.
    const welcome = new Promise<void>((resolve, reject) => {
      this.welcomeResolve = resolve;
      this.welcomeReject = reject;
    });
    transport.send({
      type: MSG.REGISTER,
      id: this.opts.workspaceId,
      workspacePaths: this.opts.workspacePaths,
      displayName: this.opts.displayName,
      instanceId: this.opts.instanceId,
      instanceName: this.opts.instanceName,
      state: this.state,
    });
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
      `[worker] registered with leader via ${transport.kind} transport as ${this.opts.displayName}`,
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
   * without state. After REGISTERED, each call sends MSG.UPDATE.
   */
  updateState(state: WindowState): void {
    this.state = state;
    if (!this.registered || !this.transport || this.transport.destroyed) return;
    this.transport.send({ type: MSG.UPDATE, state });
  }

  async stop(timeoutMs = 3000): Promise<void> {
    this.stopped = true;
    this.rejectWelcome(new Error("Worker stopped"));
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const transport = this.transport;
    this.transport = null;
    if (transport) {
      // Give in-flight member-channel POSTs a bounded chance to settle
      // before the stop completes — a stop right after a send must not race
      // the send's completion — but never wait longer than timeoutMs (M4).
      await Promise.race([
        transport.close(),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, Math.max(0, timeoutMs));
          t.unref?.();
        }),
      ]);
    }
  }

  private heartbeatTick(): void {
    if (this.stopped || !this.transport || this.transport.destroyed) return;
    // At most one PING in flight: if the previous PING was not answered by
    // now, that is one missed heartbeat. Sending a second PING while the
    // first is unanswered would count a single slow PONG (event-loop
    // throttling, GC pause, busy leader) as multiple misses and could fail
    // over a healthy leader (N2).
    if (this.pingOutstanding) {
      this.missedPongs++;
      if (this.missedPongs >= HEARTBEAT_MISS_LIMIT) {
        this.failOver(
          `no PONG for ${this.missedPongs} heartbeat intervals — leader event loop assumed frozen`,
        );
      }
      return;
    }
    this.pingOutstanding = true;
    this.transport.send({ type: MSG.PING });
  }

  private onMessage(msg: IpcMessage): void {
    if (this.stopped) return;
    switch (msg.type) {
      case MSG.WELCOME:
        this.resolveWelcome();
        break;
      case MSG.PONG:
        this.pingOutstanding = false;
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
    if (this.stopped || !this.transport || this.transport.destroyed) return;
    this.transport.send({ type: MSG.RESULT, callId, response });
  }

  private failOver(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.rejectWelcome(new Error(reason));
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.transport?.close();
    this.transport = null;
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
