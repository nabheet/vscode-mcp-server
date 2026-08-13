/**
 * Parse JSONC (JSON with comments and trailing commas) into a JS value.
 *
 * VS Code configuration files — *.code-workspace workspace files, settings.json,
 * launch.json, tasks.json — are JSONC. Strict JSON.parse fails on them because
 * they allow `//` and `/* *​/` comments and trailing commas. This is a small,
 * dependency-free stripper that removes comments and trailing commas without
 * touching string literals (so `"https://…"` and `"x, }"` survive intact).
 */
export function parseJsonc<T = unknown>(text: string): T {
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let out = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      out += ch;
      if (ch === '\\' && next !== undefined) {
        out += next;
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    // Strip trailing commas (only outside strings): `,` directly before `}`/`]`
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') {
        i = j - 1; // skip the comma; the closing bracket is emitted next
        continue;
      }
    }

    out += ch;
  }

  return JSON.parse(out) as T;
}
