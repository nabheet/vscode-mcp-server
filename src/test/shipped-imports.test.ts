import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "..", "..", "scripts", "check-shipped-imports.mjs");

interface Fixture {
  devDependencies?: Record<string, string>;
  tsconfigExclude?: string[];
  files: Record<string, string>;
}

describe("check-shipped-imports", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipped-imports-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeFixture(fixture: Fixture): void {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify(
        { name: "fixture", version: "0.0.0", devDependencies: fixture.devDependencies ?? {} },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ include: ["src/**/*"], exclude: fixture.tsconfigExclude ?? ["src/test"] }),
    );
    for (const [relative, contents] of Object.entries(fixture.files)) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    }
  }

  function run(): { ok: boolean; output: string } {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
      return { ok: true, output: stdout };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  }

  it("passes when shipped source only imports runtime and host modules", () => {
    writeFixture({
      devDependencies: { vitest: "5.0.0" },
      files: {
        "src/a.ts": 'import * as fs from "node:fs";\nimport * as vscode from "vscode";\n',
        "src/test/a.test.ts": 'import { it } from "vitest";\n',
      },
    });

    const result = run();
    expect(result.ok).toBe(true);
    expect(result.output).toContain("shipped-imports: OK");
  });

  it("fails when shipped source imports a devDependency", () => {
    writeFixture({
      devDependencies: { vitest: "5.0.0", "@scope/tool": "1.0.0" },
      files: {
        "src/a.ts": 'import { describe } from "vitest";\nexport * from "@scope/tool/sub";\n',
      },
    });

    const result = run();
    expect(result.ok).toBe(false);
    expect(result.output).toContain("devDependency 'vitest'");
    expect(result.output).toContain("devDependency '@scope/tool'");
  });

  it("fails when tsconfig compiles tests", () => {
    writeFixture({
      devDependencies: {},
      tsconfigExclude: [],
      files: { "src/a.ts": "export const a = 1;\n" },
    });

    const result = run();
    expect(result.ok).toBe(false);
    expect(result.output).toContain("tsconfig.json: 'exclude' must contain 'src/test'");
  });

  it("ignores type-only imports of runtime modules", () => {
    writeFixture({
      devDependencies: { vitest: "5.0.0" },
      files: { "src/a.ts": 'import type { X } from "./types";\nexport const a = 1;\n' },
    });

    expect(run().ok).toBe(true);
  });
});
