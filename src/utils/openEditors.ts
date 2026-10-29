import * as vscode from "vscode";

/** How a tab presents its file. */
export type OpenEditorKind = "text" | "diff" | "notebook" | "custom";

/** One editor tab that holds editable text. */
export interface OpenEditor {
  /**
   * The file's absolute path for `file:` editors, or the `untitled:` URI for
   * unsaved buffers (which have no path on disk). The same string can be
   * passed to `read_file` to read the unsaved content.
   */
  path: string;
  /** `file` for editors backed by disk, `untitled` for never-saved buffers. */
  scheme: "file" | "untitled";
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

/** Readable reference for an editor URI: a path on disk, or an untitled URI. */
export function editorReference(uri: vscode.Uri): string {
  return uri.scheme === "untitled" ? `untitled:${uri.path || uri.fsPath}` : uri.fsPath;
}

/**
 * Every editor tab that holds editable text, in tab-group order.
 *
 * `untitled:` buffers are included (they carry unsaved work an agent may need
 * to read) and are reported by URI. Virtual documents (settings pages,
 * extension webviews) are skipped: they have no readable text document.
 */
export function collectOpenEditors(): OpenEditor[] {
  const groups = vscode.window.tabGroups?.all ?? [];
  const editors: OpenEditor[] = [];
  groups.forEach((group, groupIndex) => {
    for (const tab of group.tabs ?? []) {
      const resolved = tabUri(tab);
      const scheme = resolved?.uri.scheme;
      if (!resolved || (scheme !== "file" && scheme !== "untitled")) continue;
      const visible = tab.isActive === true;
      editors.push({
        path: editorReference(resolved.uri),
        scheme,
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
