/**
 * Rotating JSON-lines file logger. Writes into the extension's `context.logUri`
 * directory so records survive hot-reload crashes that kill the process.
 *
 * Rotation: 1 MB per file, keeps mcp.log + mcp.log.1..3 (4 files max).
 * Logging failures are swallowed — the log must never crash the server.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface LogEntry {
  ts?: string;
  type: string;
  [key: string]: unknown;
}

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_LOG_FILES = 4;

export class ServerLog {
  private readonly dir: string;
  private readonly base: string;
  private bytes = 0;
  private seq = 0;

  constructor(logDir: string) {
    this.dir = logDir;
    this.base = path.join(logDir, 'mcp.log');
    try {
      fs.mkdirSync(logDir, { recursive: true });
      this.bytes = fs.existsSync(this.base) ? fs.statSync(this.base).size : 0;
    } catch {
      this.bytes = 0; // could not stat — start fresh; writes will attempt mkdir again
    }
  }

  get dirPath(): string {
    return this.dir;
  }

  log(entry: LogEntry): void {
    this.seq++;
    const line = JSON.stringify({ ...entry, ts: entry.ts ?? new Date().toISOString(), seq: this.seq }) + '\n';
    const size = Buffer.byteLength(line);
    if (this.bytes + size > MAX_LOG_BYTES) this.rotate();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.base, line);
      this.bytes += size;
    } catch {
      // Never crash the server because of logging.
    }
  }

  private rotate(): void {
    try {
      for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
        const from = path.join(this.dir, `mcp.log.${i}`);
        const to = path.join(this.dir, `mcp.log.${i + 1}`);
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      const first = path.join(this.dir, 'mcp.log.1');
      if (fs.existsSync(this.base)) fs.renameSync(this.base, first);
      this.bytes = 0;
    } catch {
      // Rotation failure is non-fatal.
    }
  }
}