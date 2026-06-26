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
};

const mockEnv = {
  remoteName: undefined as string | undefined,
};

const mockCommands = {
  executeCommand: vi.fn(),
};

// Build the mock vscode module
const mockVscode = {
  Uri: mockUri,
  workspace: mockWorkspace,
  window: mockWindow,
  env: mockEnv,
  commands: mockCommands,
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
    constructor(public uri: any, public rangeOrPosition: any) {}
  },
};

vi.mock('vscode', () => mockVscode);
