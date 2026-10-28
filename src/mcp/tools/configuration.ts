import * as vscode from "vscode";
import { defineTool, type ToolRegistrar } from "./index";

/** A section dump can serialize to megabytes (`"*"`); keep the round trip sane. */
const MAX_CONFIG_BYTES = 200 * 1024;

/**
 * Settings can hold credentials (extension API keys, `vscode-mcp-server.authToken`).
 * This tool has no workspace boundary, so redact obvious secret-looking values
 * before they leave the extension host.
 *
 * Matching is per dotted-path segment: `token` is an end-of-segment suffix
 * (catches `authToken`, `access_token`, `apiToken`,; leaves
 * `tokenColorCustomizations` alone), and `auth` / `bearer` match a whole
 * segment only. A section named `credentials` therefore redacts every child.
 *
 * This is a heuristic keyed on names. A secret stored under an innocuous key
 * (e.g. `myExt.value = "ghp_..."`) is not detected; URL userinfo is masked
 * separately in `redactDeep`.
 */
const SECRET_SEGMENT =
  /token$|secret|password|passwd|api[_-]?key|credential|connection[_-]?string|private[_-]?key|authorization|^auth$|^bearer$/i;

/** True when any segment of a dotted key looks secret. */
function isSecretName(name: string): boolean {
  return name.split(".").some((segment) => SECRET_SEGMENT.test(segment));
}

/** Mask URL userinfo: `scheme://user:pass@host` → `scheme://<redacted>@host`. */
function redactUrlUserinfo(value: string): string {
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, "$1<redacted>@");
}

function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretName(k) && v !== undefined && v !== null ? "<redacted>" : redactDeep(v);
    }
    return out;
  }
  if (typeof value === "string") return redactUrlUserinfo(value);
  return value;
}

/** Redact a value by its dotted path, recursing into nested objects/arrays. */
function redactValue(path: string, value: unknown): unknown {
  if (isSecretName(path) && value !== undefined && value !== null) return "<redacted>";
  return redactDeep(value);
}

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
      // Reads user/default/folder-scoped settings without a workspace boundary,
      // so secret-looking keys are redacted to "<redacted>" and URL userinfo is
      // masked. The redaction is name-based: a secret under an innocuous key is
      // not detected.
      "Read VS Code settings, the effective values rather than the raw settings files. Returns a section as a JSON object, or one key's JSON value. Values include defaults, user and workspace-folder settings, which is what the editor actually applies. A section nobody defines returns {}. Pass languageId to apply language-specific overrides such as \"[typescript]\"; pass workspaceFolder to also fold in that folder's settings in a multi-root workspace. Secret-looking keys (tokens, passwords, API keys, credentials) are redacted and URL userinfo is masked, but redaction is name-based: a secret stored under an innocuous key name is not detected.",
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
              'Optional language for language-specific overrides, e.g. "typescript". Applies user/default language overrides; combine with workspaceFolder for folder-scoped overrides.',
          },
        },
      },
      async (args) => {
        const section =
          args.section === undefined || args.section === "" ? undefined : String(args.section);
        const key = args.key === undefined || args.key === "" ? undefined : String(args.key);
        const languageId =
          args.languageId === undefined || args.languageId === ""
            ? undefined
            : String(args.languageId);

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
          if (args.workspaceFolder !== undefined && args.workspaceFolder !== "") {
            const uri = folderUri(String(args.workspaceFolder));
            scope = languageId ? { uri, languageId } : uri;
          } else if (languageId) {
            // Language overrides at window scope: `{ languageId }` is a valid
            // ConfigurationScope on its own (applies user/default overrides),
            // so there is no reason to borrow a folder.
            scope = { languageId };
          }
        } catch (err) {
          return {
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }

        const config = vscode.workspace.getConfiguration(section, scope);
        let value: unknown;
        if (key !== undefined) {
          if (!config.has(key)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Setting '${section ? `${section}.` : ""}${key}' is not set.`,
                },
              ],
              isError: true,
            };
          }
          value = redactValue(section ? `${section}.${key}` : key, config.get(key));
        } else {
          const entries: Record<string, unknown> = {};
          // WorkspaceConfiguration mixes `has`/`get`/`update`/`inspect` in with
          // the section keys; read through `get` so only effective values land.
          for (const name of Object.keys(config)) {
            if (typeof (config as unknown as Record<string, unknown>)[name] === "function")
              continue;
            entries[name] = redactValue(`${section}.${name}`, config.get(name));
          }
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
