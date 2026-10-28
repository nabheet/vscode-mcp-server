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
  /**
   * The tab is a preview tab: the next file opened in the same group replaces
   * it instead of adding a tab.
   */
  isPreview: boolean;
  /** Index of the containing tab group. */
  group: number;
}

function tabUri(tab: vscode.Tab): { uri: vscode.Uri; kind: OpenEditorKind } | undefined {
  const input = tab.input;
  // A diff tab compares two documents; the file on disk (and the one an agent
  // would edit) is the modified side.
  if (input instanceof vscode.TabInputTextDiff) {
    return { uri: input.modified, kind: "diff" };
  }
  if (input instanceof vscode.TabInputText) {
    return { uri: input.uri, kind: "text" };
  }
  if (input instanceof vscode.TabInputNotebook) {
    return { uri: input.uri, kind: "notebook" };
  }
  if (input instanceof vscode.TabInputCustom) {
    return { uri: input.uri, kind: "custom" };
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
        isPreview: tab.isPreview === true,
        group: groupIndex,
      });
    }
  });
  return editors;
}
