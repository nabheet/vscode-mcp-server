import { describe, it, expect } from 'vitest';
import { parseJsonc } from '../utils/jsonc';

describe('parseJsonc', () => {
  it('parses plain JSON', () => {
    expect(parseJsonc('{"a": 1}')).toEqual({ a: 1 });
  });

  it('strips line comments', () => {
    expect(parseJsonc('{\n  // comment\n  "a": 1\n}')).toEqual({ a: 1 });
  });

  it('strips line comment at end of file without newline', () => {
    expect(parseJsonc('{"a": 1} // trailing comment')).toEqual({ a: 1 });
  });

  it('strips block comments', () => {
    expect(parseJsonc('{ /* c */ "a": 1 /* trailing */ }')).toEqual({ a: 1 });
  });

  it('strips multi-line block comments', () => {
    expect(parseJsonc('{ /* line1\n   line2 */ "a": 1 }')).toEqual({ a: 1 });
  });

  it('keeps // inside strings (e.g. URLs)', () => {
    expect(parseJsonc('{"url": "https://example.com/x", "a": 1}')).toEqual({
      url: 'https://example.com/x',
      a: 1,
    });
  });

  it('keeps /* inside strings', () => {
    expect(parseJsonc('{"s": "a /* b */ c"}')).toEqual({ s: 'a /* b */ c' });
  });

  it('keeps escaped quotes inside strings', () => {
    expect(parseJsonc('{"s": "say \\"hi\\""}')).toEqual({ s: 'say "hi"' });
  });

  it('strips trailing commas', () => {
    expect(parseJsonc('{"a": 1, "b": [1, 2,],}')).toEqual({ a: 1, b: [1, 2] });
  });

  it('does not strip commas inside strings', () => {
    expect(parseJsonc('{"s": "x, }", "a": 1}')).toEqual({ s: 'x, }', a: 1 });
  });

  it('parses a full JSONC workspace file', () => {
    const text = `{
      // VS Code generated workspace file
      "folders": [
        { "name": "root", "path": "." },
      ],
      "launch": {
        "version": "0.2.0", /* debug configs */
        "configurations": [ { "name": "Ws", "type": "node", "request": "launch" }, ],
      },
    }`;
    expect(parseJsonc(text)).toEqual({
      folders: [{ name: 'root', path: '.' }],
      launch: {
        version: '0.2.0',
        configurations: [{ name: 'Ws', type: 'node', request: 'launch' }],
      },
    });
  });

  it('throws on invalid JSON after stripping', () => {
    expect(() => parseJsonc('{ bad json }')).toThrow();
  });
});
