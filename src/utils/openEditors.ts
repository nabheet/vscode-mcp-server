import * as vscode from "vscode";

/** How a tab presents its file. */
export type OpenEditorKind = "text" | "diff" | "notebook" | "custom";

/** One file open in an editor tab. */
export interface OpenEditor {
  /** Absolute path of the file the tab shows. */
  path: string;
  kind: OpenEditorKind;
  /** The tab is the rendered tab of its group (only one tab per group renders). */
  isVisible: boolean;
  /** The tab is in the focused group and is that group's active tab. */
  isActive: boolean;
  /** The tab has unsaved changes. */
  isDirty: boolean;
  /** Index of the containing tab group. */
  group: number;
}

/**
 * `instanceof` against an API class that a test double may not define. VS Code
 * always defines these; unit-test mocks often stub only the ones in use.
 */
function isInstance(input: unknown, ctor: unknown): boolean {
  return typeof ctor === "function" && input instanceof (ctor as new (...a: never[]) => unknown);
}

function tabUri(tab: vscode.Tab): { uri: vscode.Uri; kind: OpenEditorKind } | undefined {
  const input = tab.input;
  // A diff tab compares two documents; the file on disk (and the one an agent
  // would edit) is the modified side.
  if (isInstance(input, vscode.TabInputTextDiff)) {
    return { uri: (input as vscode.TabInputTextDiff).modified, kind: "diff" };
  }
  if (isInstance(input, vscode.TabInputText)) {
    return { uri: (input as vscode.TabInputText).uri, kind: "text" };
  }
  if (isInstance(input, vscode.TabInputNotebook)) {
    return { uri: (input as vscode.TabInputNotebook).uri, kind: "notebook" };
  }
  if (isInstance(input, vscode.TabInputCustom)) {
    return { uri: (input as vscode.TabInputCustom).uri, kind: "custom" };
  }
  return undefined;
}

/**
 * Every editor tab that shows a file on disk, in tab-group order.
 *
 * Untitled buffers and virtual documents (settings, extension pages) have no
 * `file:` path and are skipped — this list is for files an agent can read.
 */
export function collectOpenEditors(): OpenEditor[] {
  const groups = vscode.window.tabGroups?.all ?? [];
  const editors: OpenEditor[] = [];
  groups.forEach((group, groupIndex) => {
    for (const tab of group.tabs ?? []) {
      const resolved = tabUri(tab);
      if (resolved?.uri.scheme !== "file") continue;
      const visible = tab.isActive === true;
      editors.push({
        path: resolved.uri.fsPath,
        kind: resolved.kind,
        isVisible: visible,
        isActive: visible && group.isActive === true,
        isDirty: tab.isDirty === true,
        group: groupIndex,
      });
    }
  });
  return editors;
}
