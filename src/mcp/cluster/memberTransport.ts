/**
 * MemberTransport — the Worker→Leader channel abstraction.
 *
 * The cluster protocol (REGISTER / WELCOME / CALL / RESULT / PING / PONG /
 * UPDATE) is transport-agnostic: the WorkerCoordinator talks to whichever
 * transport the bootstrap step chose, and the Leader talks to whichever
 * transport a peer connected over.
 *
 * Every Worker connects over the HTTP "member channel" on the Leader's
 * single port — the same port the server already listens on, so no extra
 * port or firewall rule is needed. This works for same-host windows AND
 * across mount namespaces (dev container ↔ host). The channel is:
 *
 *   Worker → Leader:  POST /cluster/message?id=<sessionId> (send leg)
 *   Leader → Worker:  GET  /cluster/stream?id=<sessionId>  (SSE receive leg)
 *
 * The channel carries the exact same IpcMessage JSON; only the direction of
 * the two legs differs. The shared `authToken` is REQUIRED whenever any bind
 * is non-loopback (C1): the channel proxies tools/call — including shell
 * commands — to every connected worker, so an unauthenticated non-loopback
 * bind would expose remote code execution. Loopback-only binds (the
 * macOS/Windows default) need no token; CORS/origin checks still stop a
 * malicious webpage from driving the channel via DNS rebinding.
 */
import { randomUUID } from "node:crypto";
import {
  CLUSTER_MESSAGE_PATH,
  CLUSTER_STREAM_PATH,
  MEMBER_HTTP_TIMEOUT_MS,
  MEMBER_POST_RETRIES,
  MEMBER_POST_RETRY_DELAY_MS,
} from "./constants";
import type { IpcMessage } from "./protocol";

export interface MemberTransport {
  readonly kind: "http";
  /** Set by the coordinator before connect(): a message arrived. */
  onMessage: ((msg: IpcMessage) => void) | null;
  /** Set by the coordinator before connect(): the channel is gone. */
  onClose: ((reason: string) => void) | null;
  /** Establish the channel. Rejects on failure (caller re-elects). */
  connect(): Promise<void>;
  /** Send one protocol message. Best-effort: no-ops after close. */
  send(msg: IpcMessage): void;
  /**
   * Tear the channel down (idempotent). May return a promise that settles
   * once in-flight POSTs have finished, so callers can wait for the flush.
   */
  close(): void | Promise<void>;
  readonly destroyed: boolean;
}

/**
 * Build an origin for a cross-boundary leader host. IPv6 literals need
 * brackets in URLs (`http://[::1]:9876`), everything else is plain
 * (`http://host.docker.internal:9876`).
 */
export function memberBaseUrl(scheme: string, host: string, port: number): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${scheme}://${h}:${port}`;
}

// ── HTTP member transport ─────────────────────────────────────────────

export interface HttpMemberTransportOptions {
  /** e.g. `http://127.0.0.1:9876` or `http://host.docker.internal:9876`. */
  baseUrl: string;
  /** Worker-chosen session id; defaults to a random UUID. */
  sessionId?: string;
  /** Shared bearer token (only sent when the server is configured with one). */
  authToken?: string;
  log?: (msg: string) => void;
}

export class HttpMemberTransport implements MemberTransport {
  readonly kind = "http" as const;
  onMessage: ((msg: IpcMessage) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;

  private readonly baseUrl: string;
  private readonly sessionId: string;
  private readonly authToken?: string;
  private readonly log?: (msg: string) => void;
  private controller: AbortController | null = null;
  private closedByUs = false;
  private ended = false;
  /** In-flight POST promises, awaited by close() so callers can flush. */
  private inflight = new Set<Promise<void>>();

  constructor(opts: HttpMemberTransportOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.sessionId = opts.sessionId ?? randomUUID();
    this.authToken = opts.authToken;
    this.log = opts.log;
  }

  get destroyed(): boolean {
    return this.closedByUs || this.ended;
  }

  /**
   * Open the SSE receive leg first: the Leader only routes POSTs for a
   * session after its stream is registered, and the fetch() promise resolves
   * once the response headers arrive — i.e. after the Leader's stream
   * handler ran. Only then is it safe to POST REGISTER.
   */
  async connect(): Promise<void> {
    const url = `${this.baseUrl}${CLUSTER_STREAM_PATH}?id=${encodeURIComponent(this.sessionId)}`;
    const controller = new AbortController();
    this.controller = controller;
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers: this.headers(), signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw new Error("Worker stopped while connecting");
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (!res.ok || !res.body) {
      throw new Error(`member stream GET failed: HTTP ${res.status}`);
    }
    // Fire-and-forget read loop; stream errors surface via onClose.
    void this.readLoop(res.body, controller.signal).catch((err) => {
      this.ended = true;
      if (controller.signal.aborted) return; // we closed it — not a failure
      this.log?.(
        `[worker] member stream ended: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.onClose?.("member stream closed");
    });
  }

  send(msg: IpcMessage): void {
    if (this.destroyed) return;
    let p: Promise<void>;
    p = this.postWithRetry(msg, 0).finally(() => {
      this.inflight.delete(p);
    });
    this.inflight.add(p);
  }

  /** POST one message, retrying transient failures (N1). Resolves once the
   * leader acked (HTTP 2xx); logs and gives up after MEMBER_POST_RETRIES.
   * Only transient failures are retried: network errors, timeouts, and 5xx.
   * A 4xx response is terminal (the leader got the request and rejected it —
   * retrying cannot change that) so it is logged and not retried. Also bails
   * once the transport is destroyed, so a close() is not followed by up to
   * MEMBER_POST_RETRIES further attempts (~30s of stray POSTs). */
  private async postWithRetry(msg: IpcMessage, attempt: number): Promise<void> {
    if (this.destroyed) return;
    const url = `${this.baseUrl}${CLUSTER_MESSAGE_PATH}?id=${encodeURIComponent(this.sessionId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MEMBER_HTTP_TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers() },
        body: JSON.stringify(msg),
        signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status >= 400 && res.status < 500) {
          this.log?.(`[worker] member POST (${msg.type}) rejected: HTTP ${res.status}`);
          return;
        }
        throw new Error(`member POST (${msg.type}) failed: HTTP ${res.status}`);
      }
    } catch (err) {
      if (this.destroyed) return;
      if (attempt < MEMBER_POST_RETRIES) {
        await sleep(MEMBER_POST_RETRY_DELAY_MS);
        return this.postWithRetry(msg, attempt + 1);
      }
      this.log?.(
        `[worker] member POST (${msg.type}) failed after ${attempt + 1} attempts: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // A failed POST is non-fatal — the SSE stream is the liveness source.
      // If the leader is truly gone the stream closes and triggers failOver
      // via onClose.
    } finally {
      clearTimeout(timer);
    }
  }

  close(): Promise<void> {
    this.closedByUs = true;
    this.controller?.abort();
    this.controller = null;
    const inflight = Array.from(this.inflight);
    this.inflight.clear();
    // Resolve once in-flight POSTs settled, so a caller can flush before
    // treating the transport as fully closed (M4).
    return Promise.allSettled(inflight).then(() => undefined);
  }

  private headers(): Record<string, string> {
    return this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {};
  }

  private async readLoop(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = this.parseSse(buffer + decoder.decode(value, { stream: true }));
    }
    this.ended = true;
    if (!signal.aborted) this.onClose?.("member stream ended");
  }

  /**
   * Consume complete SSE blocks from `buffer`, emitting every
   * `event: message` payload as an IpcMessage; returns the unparsed tail.
   * Handles CRLF line endings and `:` comment/keepalive lines.
   */
  private parseSse(buffer: string, emit = (msg: IpcMessage) => this.onMessage?.(msg)): string {
    for (;;) {
      const idx = buffer.indexOf("\n\n");
      if (idx === -1) break;
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "";
      const dataLines: string[] = [];
      for (const rawLine of block.split("\n")) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.startsWith(":")) continue; // comment / keepalive
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (event !== "message" || dataLines.length === 0) continue;
      const data = dataLines.join("\n");
      try {
        const parsed = JSON.parse(data) as unknown;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as IpcMessage).type === "string"
        ) {
          emit(parsed as IpcMessage);
        }
      } catch {
        this.log?.(`[worker] ignoring non-JSON member event: ${data.slice(0, 120)}`);
      }
    }
    return buffer;
  }
}

/** Minimal delay helper for retry backoff. */
async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
