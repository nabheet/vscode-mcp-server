/**
 * Length-prefixed JSON framing for the Master-Worker IPC pipe.
 *
 * Each frame is: 4-byte big-endian payload length + UTF-8 JSON body.
 * Length-prefixing (vs NDJSON) is deliberate: tool results (file reads,
 * terminal output) can be megabytes, may arrive split across many TCP
 * chunks, and must not be confused with frame boundaries. The length header
 * also lets us reject corrupt/garbage frames instead of hanging.
 */
import { MAX_FRAME_BYTES } from './constants';

export interface IpcMessage {
  type: string;
  [key: string]: unknown;
}

export const HEADER_BYTES = 4;

/** Serialize one message into a length-prefixed frame. */
export function encodeMessage(msg: IpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf-8');
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`IPC frame too large (${body.length} bytes > ${MAX_FRAME_BYTES})`);
  }
  const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, HEADER_BYTES);
  return frame;
}

export class FrameDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameDecodeError';
  }
}

/**
 * Incremental decoder. Feed it raw socket chunks; it calls `onMessage` for
 * every complete frame and throws FrameDecodeError on malformed input.
 */
export function createDecoder(onMessage: (msg: IpcMessage) => void): (chunk: Buffer) => void {
  // Buffer<ArrayBufferLike> (the default generic) so both Buffer.alloc(0)
  // (Buffer<ArrayBuffer>) and subarray() (Buffer<ArrayBufferLike>) assign.
  let buffer: Buffer = Buffer.alloc(0);

  return (chunk: Buffer): void => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

    while (buffer.length >= HEADER_BYTES) {
      const len = buffer.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) {
        throw new FrameDecodeError(`Frame length ${len} exceeds maximum ${MAX_FRAME_BYTES}`);
      }
      if (buffer.length < HEADER_BYTES + len) break; // wait for more data

      const body = buffer.subarray(HEADER_BYTES, HEADER_BYTES + len).toString('utf-8');
      buffer = buffer.subarray(HEADER_BYTES + len);

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new FrameDecodeError('Frame body is not valid JSON');
      }
      if (typeof parsed !== 'object' || parsed === null || typeof (parsed as IpcMessage).type !== 'string') {
        throw new FrameDecodeError('Frame body is not an IPC message (missing string "type")');
      }
      onMessage(parsed as IpcMessage);
    }
  };
}