import { collectOpenEditors } from "../../utils/openEditors";
import { defineTool, type ToolRegistrar } from "./index";

export function registerEditorsTools(server: ToolRegistrar): void {
  server.registerTool(
    defineTool(
      "get_open_editors",
      // Untitled buffers have no path, so they are skipped until #131 adds
      // them as flagged entries with their unsaved content.
      "List the files open in VS Code editors, in tab-group order. Returns absolute paths with flags for the visible tab of each group, the active editor of the active group, unsaved changes, preview tabs (a preview tab is replaced by the next open in its group), and the tab-group index. The same file open in two groups appears twice. Untitled buffers and virtual documents (settings, extension pages) are skipped; a diff tab reports the file on disk. An empty list is a valid result, not an error.",
      {
        type: "object",
        properties: {
          includeVisible: {
            type: "boolean",
            description:
              "Only return editors currently visible in their tab group — one per group — omitting background tabs (default: false)",
          },
        },
      },
      async (args) => {
        const editors = collectOpenEditors();
        const selected =
          args.includeVisible === true ? editors.filter((e) => e.isVisible) : editors;
        return {
          content: [{ type: "text", text: JSON.stringify(selected, null, 2) }],
          isError: false,
        };
      },
    ),
  );
}
