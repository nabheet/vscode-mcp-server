import * as vscode from "vscode";
import { defineTool, type ToolRegistrar } from "./index";

/** A section dump can serialize to megabytes (`"*"`); keep the round trip sane. */
const MAX_CONFIG_BYTES = 200 * 1024;

/** Resolve the `workspaceFolder` argument to the folder's URI. */
function folderUri(ref: string): vscode.Uri {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error(`Workspace folder '${ref}' specified but no workspace folders are open`);
  }
  const folder = folders.find((f) => f.name === ref || f.uri.fsPath === ref);
  if (!folder) {
    const names = folders.map((f) => `${f.name} (${f.uri.fsPath})`).join(", ");
    throw new Error(`Workspace folder '${ref}' not found. Available folders: ${names}`);
  }
  return folder.uri;
}

export function registerConfigurationTools(server: ToolRegistrar): void {
  server.registerTool(
    defineTool(
      "get_configuration",
      // Language-scoped values need a resource: VS Code cannot resolve a
      // `[typescript]` override without one, so `languageId` borrows the
      // workspace folder (the first one when unspecified).
      "Read VS Code settings, the effective values rather than the raw settings files. Returns a section as a JSON object, or one key's JSON value. Values include defaults, user and workspace-folder settings, which is what the editor actually applies. A section nobody defines returns {}. Pass languageId to apply language-specific overrides (e.g. editor.tabSize for typescript); it needs a workspace folder as its resource.",
      {
        type: "object",
        properties: {
          section: {
            type: "string",
            description:
              'Settings section to read, e.g. "editor" or "files" (omit to read one top-level key)',
          },
          key: {
            type: "string",
            description:
              'Optional single setting within the section, e.g. "tabSize" (returns its value)',
          },
          workspaceFolder: {
            type: "string",
            description:
              "Optional workspace folder name (for multi-root workspaces). Folder-specific settings apply.",
          },
          languageId: {
            type: "string",
            description:
              'Optional language for language-specific overrides, e.g. "typescript". Needs a workspace folder as its resource.',
          },
        },
      },
      async (args) => {
        const section = args.section === undefined ? undefined : String(args.section);
        const key = args.key === undefined ? undefined : String(args.key);
        const languageId = args.languageId === undefined ? undefined : String(args.languageId);

        if (section === undefined && key === undefined) {
          return {
            content: [
              {
                type: "text",
                text: 'Pass a section (e.g. "editor") or both a section and a key; reading every setting at once is not supported.',
              },
            ],
            isError: true,
          };
        }

        let scope: vscode.ConfigurationScope | undefined;
        try {
          if (args.workspaceFolder !== undefined) {
            const uri = folderUri(String(args.workspaceFolder));
            scope = languageId ? { uri, languageId } : uri;
          } else if (languageId) {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders || folders.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `languageId '${languageId}' needs a workspace folder as its resource, and no folder is open.`,
                  },
                ],
                isError: true,
              };
            }
            scope = { uri: folders[0].uri, languageId };
          }
        } catch (err) {
          return {
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }

        // A section-only call (no key, no section) is unreachable: guarded above.
        const config = vscode.workspace.getConfiguration(section, scope);
        let value: unknown;
        if (key !== undefined) {
          value = config.get(key) ?? null;
        } else {
          const entries: Record<string, unknown> = {};
          for (const name of Object.keys(config)) entries[name] = config.get(name);
          value = entries;
        }

        const text = JSON.stringify(value, null, 2);
        if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
          return {
            content: [
              {
                type: "text",
                text: `"${section ?? key}" serializes to ${Buffer.byteLength(text, "utf8")} bytes, over the 200 KB limit. Read one key instead, or narrow the section.`,
              },
            ],
            isError: true,
          };
        }
        return { content: [{ type: "text", text }], isError: false };
      },
    ),
  );
}
