/**
 * Wire types shared by the Leader and Worker sides of the cluster protocol.
 *
 * The same JSON messages (REGISTER / WELCOME / CALL / RESULT / PING / PONG /
 * UPDATE) travel over the HTTP member channel in both directions: the
 * Leader's SSE stream down to the Worker, and the Worker's POSTs up to the
 * Leader. No framing lives here — JSON is the wire format.
 */

export interface IpcMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Per-window UI state surfaced in `list_workspaces` so a client can
 * distinguish two windows that share the same folder/name (e.g. "the
 * window where file X is open"). Populated by extension.ts from the
 * VS Code window; carried in REGISTER and refreshed via MSG.UPDATE.
 */
export interface WindowState {
  /** Absolute path of the active editor's document, if any. */
  activeFile?: string;
  /** Absolute paths of all open editor tabs. */
  openEditors: string[];
}
