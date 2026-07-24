import { vi } from 'vitest';

/**
 * Minimal mock for the `vscode` module.
 * Add stubs as needed for new tests.
 */
const mockUri = {
  file: (path: string) => ({ fsPath: path, scheme: 'file', path, toString: () => path }),
  parse: (uri: string) => ({ fsPath: uri.replace('file://', ''), scheme: 'file', path: uri, toString: () => uri }),
};

const mockWorkspace = {
  workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
  getConfiguration: () => ({
    get: <T>(_: string, defaultValue?: T) => defaultValue,
  }),
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
  openTextDocument: vi.fn(),
};

const mockWindow = {
  createOutputChannel: () => ({
    appendLine: vi.fn(),
    append: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  }),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  activeTextEditor: undefined as any,
  onDidChangeActiveTextEditor: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  onDidChangeTextEditorSelection: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  onDidOpenTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  showTextDocument: vi.fn(),
};

const mockEnv = {
  remoteName: undefined as string | undefined,
};

const mockDebug = {
  activeDebugSession: undefined as any,
  stopDebugging: vi.fn(),
  startDebugging: vi.fn(),
  addBreakpoints: vi.fn((bps: any[]) => {
    (mockDebug.breakpoints as any[]).push(...bps);
  }),
  removeBreakpoints: vi.fn((bps: any[]) => {
    const arr = mockDebug.breakpoints as any[];
    for (const bp of bps) {
      const idx = arr.indexOf(bp);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }),
  breakpoints: [] as any[],
  onDidChangeActiveDebugSession: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  onDidTerminateDebugSession: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  onDidChangeBreakpoints: vi.fn().mockReturnValue({ dispose: vi.fn() }),
};

const mockCommands = {
  executeCommand: vi.fn(),
  getCommands: vi.fn().mockResolvedValue(['cmd1', 'cmd2']),
};

// Build the mock vscode module
const mockVscode = {
  Uri: mockUri,
  workspace: mockWorkspace,
  window: mockWindow,
  env: mockEnv,
  commands: mockCommands,
  debug: mockDebug,
  // For ExtensionContext type used in path.ts indirectly
  ExtensionContext: class {
    subscriptions: { dispose: () => void }[] = [];
  },
  // Placeholder for types used but not called during unit tests
  Position: class {
    constructor(public line: number, public character: number) {}
  },
  Range: class {
    constructor(
      public start: { line: number; character: number },
      public end: { line: number; character: number },
    ) {}
  },
  Location: class {
    constructor(uri: any, rangeOrPosition: any) {
      this.uri = uri;
      // Normalize: if given a Position, create a zero-length Range
      this.range = rangeOrPosition?.line !== undefined
        ? { start: rangeOrPosition, end: rangeOrPosition }
        : rangeOrPosition;
    }
    uri: any;
    range: any;
  },
  SourceBreakpoint: class {
    constructor(
      public location: any,
      public enabled: boolean,
      public condition?: string,
      public hitCondition?: string,
    ) {}
  },
  Selection: class {
    constructor(public start: any, public end: any) {}
  },
  TextEditorRevealType: { InCenter: 0 },
};

vi.mock('vscode', () => mockVscode);
