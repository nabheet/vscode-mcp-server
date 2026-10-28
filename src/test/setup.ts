import { vi } from "vitest";

/**
 * Minimal mock for the `vscode` module.
 * Add stubs as needed for new tests.
 */
const mockUri = {
  file: (path: string) => ({ fsPath: path, scheme: "file", path, toString: () => path }),
  /**
   * Split a URI into scheme + path the way VS Code does: a scheme needs 2+
   * characters before the colon (so a Windows drive letter is not a scheme),
   * and the percent-encoded path is decoded.
   */
  parse: (uri: string) => {
    const match = /^([a-z][a-z0-9+.-]+):(.*)$/i.exec(uri);
    if (!match) return { fsPath: uri, scheme: "file", path: uri, toString: () => uri };
    const scheme = match[1].toLowerCase();
    const rest = decodeURIComponent(match[2].replace(/^\/\//, ""));
    return { fsPath: rest, scheme, path: rest, toString: () => uri };
  },
  joinPath: (uri: { fsPath?: string; scheme?: string; path?: string }, ...paths: string[]) => ({
    fsPath: [uri.fsPath, ...paths].join("/"),
    scheme: uri.scheme ?? "file",
    path: [uri.path ?? uri.fsPath, ...paths].join("/"),
    toString: () => [uri.fsPath, ...paths].join("/"),
  }),
};

const mockWorkspace = {
  workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
  workspaceFile: undefined as { uri: { scheme: string; fsPath: string } } | undefined,
  fs: {
    readFile: vi.fn(),
    stat: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  },
  findFiles: vi.fn().mockResolvedValue([]),
  applyEdit: vi.fn().mockResolvedValue(true),
  updateWorkspaceFolders: vi.fn(),
  onDidChangeWorkspaceFolders: vi.fn().mockImplementation((cb: () => void) => {
    cb();
    return { dispose: vi.fn() };
  }),
  getConfiguration: () => ({
    get: <T>(_: string, defaultValue?: T) => defaultValue,
  }),
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
  textDocuments: [] as unknown[],
  openTextDocument: vi.fn(),
};

const mockWindow = {
  tabGroups: { all: [] as unknown[] },
  createOutputChannel: () => ({
    appendLine: vi.fn(),
    append: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  }),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  activeTextEditor: undefined as unknown,
  onDidChangeActiveTextEditor: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  onDidChangeTextEditorSelection: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  onDidOpenTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  showTextDocument: vi.fn(),
};

const mockEnv = {
  remoteName: undefined as string | undefined,
};

const mockDebug = {
  activeDebugSession: undefined as unknown,
  stopDebugging: vi.fn(),
  startDebugging: vi.fn(),
  addBreakpoints: vi.fn((bps: unknown[]) => {
    (mockDebug.breakpoints as unknown[]).push(...bps);
  }),
  removeBreakpoints: vi.fn((bps: unknown[]) => {
    const arr = mockDebug.breakpoints as unknown[];
    for (const bp of bps) {
      const idx = arr.indexOf(bp);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }),
  breakpoints: [] as unknown[],
  onDidChangeActiveDebugSession: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  onDidTerminateDebugSession: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  onDidChangeBreakpoints: vi.fn().mockReturnValue({ dispose: vi.fn() }),
};

const mockCommands = {
  executeCommand: vi.fn(),
  getCommands: vi.fn().mockResolvedValue(["cmd1", "cmd2"]),
};

/** Language API surface used by lsp.ts. `getDiagnostics` has two overloads. */
const mockLanguages = {
  getDiagnostics: vi.fn().mockReturnValue([]),
};

/** Minimal reverse mapping for `vscode.SymbolKind[kind]` lookups in lsp.ts. */
const mockSymbolKind: Record<number, string> = {
  0: "File",
  1: "Module",
  2: "Namespace",
  3: "Package",
  4: "Class",
  5: "Method",
};

// Build the mock vscode module
const mockVscode = {
  Uri: mockUri,
  RelativePattern: class {
    constructor(
      public base: unknown,
      public pattern: string,
    ) {}
  },
  workspace: mockWorkspace,
  window: mockWindow,
  env: mockEnv,
  commands: mockCommands,
  languages: mockLanguages,
  debug: mockDebug,
  SymbolKind: mockSymbolKind,
  // File system types used by get_file_info's `stat()` result.
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  // For ExtensionContext type used in path.ts indirectly
  ExtensionContext: class {
    subscriptions: { dispose: () => void }[] = [];
  },
  // Tab inputs: real constructors, so `instanceof` checks in openEditors.ts
  // behave the way they do in VS Code.
  TabInputText: class {
    constructor(public uri: unknown) {}
  },
  TabInputTextDiff: class {
    constructor(
      public original: unknown,
      public modified: unknown,
    ) {}
  },
  TabInputNotebook: class {
    constructor(
      public uri: unknown,
      public notebookType: string,
    ) {}
  },
  TabInputCustom: class {
    constructor(
      public uri: unknown,
      public viewType: string,
    ) {}
  },
  // Placeholder for types used but not called during unit tests
  Position: class {
    constructor(
      public line: number,
      public character: number,
    ) {}
  },
  Range: class {
    constructor(
      public start: { line: number; character: number },
      public end: { line: number; character: number },
    ) {}
  },
  Location: class {
    constructor(uri: unknown, rangeOrPosition: unknown) {
      this.uri = uri;
      // Normalize: if given a Position, create a zero-length Range
      this.range =
        (rangeOrPosition as { line?: number } | null)?.line !== undefined
          ? { start: rangeOrPosition, end: rangeOrPosition }
          : rangeOrPosition;
    }
    uri: unknown;
    range: unknown;
  },
  SourceBreakpoint: class {
    constructor(
      public location: unknown,
      public enabled: boolean,
      public condition?: string,
      public hitCondition?: string,
    ) {}
  },
  Selection: class {
    constructor(
      public start: unknown,
      public end: unknown,
    ) {}
  },
  /**
   * Records operations so tests can assert on the batch that was handed to
   * `workspace.applyEdit` (the real apply is mocked out in unit tests).
   */
  WorkspaceEdit: class {
    ops: {
      kind: string;
      uri: unknown;
      range?: unknown;
      position?: unknown;
      newText?: string;
      options?: unknown;
    }[] = [];
    createFile(uri: unknown, options?: unknown) {
      this.ops.push({ kind: "createFile", uri, options });
    }
    deleteFile(uri: unknown, options?: unknown) {
      this.ops.push({ kind: "deleteFile", uri, options });
    }
    replace(uri: unknown, range: unknown, newText: string) {
      this.ops.push({ kind: "replace", uri, range, newText });
    }
    insert(uri: unknown, position: unknown, newText: string) {
      this.ops.push({ kind: "insert", uri, position, newText });
    }
  },
  TextEditorRevealType: { InCenter: 0 },
};

vi.mock("vscode", () => mockVscode);
