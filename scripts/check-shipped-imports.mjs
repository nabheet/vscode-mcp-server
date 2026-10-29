#!/usr/bin/env node
/**
 * Fail when code that ships in the VSIX depends on a devDependency.
 *
 * The release guard treats devDependency bumps as non-shipping because those
 * packages are build/test/lint only. That holds only while:
 *   1. no shipped source imports a devDependency, and
 *   2. tests stay out of the compiled output.
 *
 * This script enforces both, so the guard's classification cannot rot.
 *
 * Usage: node scripts/check-shipped-imports.mjs [projectRoot]
 */

import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";

const PROJECT_ROOT = path.resolve(process.argv[2] ?? ".");
const SRC_DIR = path.join(PROJECT_ROOT, "src");
const TEST_DIR_NAME = "test";
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Specifiers the host or Node provides, never installed from the registry. */
const PROVIDED = new Set(["vscode"]);

const IMPORT_FROM_RE = /\b(?:import|export)\s+(?:type\s+)?[\s\S]*?\bfrom\s*["']([^"']+)["']/g;
const IMPORT_BARE_RE = /\bimport\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

function collectSpecifiers(source) {
  const found = new Set();
  for (const re of [IMPORT_FROM_RE, IMPORT_BARE_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    for (let match = re.exec(source); match !== null; match = re.exec(source)) {
      found.add(match[1]);
    }
  }
  return found;
}

/** Registry package name for a bare specifier: `@scope/name` or `name`. */
function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function isShippedSource(relativePath, fileName) {
  if (relativePath.split(path.sep).includes(TEST_DIR_NAME)) return false;
  return !TEST_FILE_RE.test(fileName);
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && /\.[cm]?tsx?$|\.jsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

async function main() {
  const problems = [];

  const pkg = JSON.parse(await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  const devDependencies = new Set(Object.keys(pkg.devDependencies ?? {}));

  for await (const file of walk(SRC_DIR)) {
    const relativePath = path.relative(PROJECT_ROOT, file);
    if (!isShippedSource(path.relative(SRC_DIR, file), path.basename(file))) continue;

    const source = await readFile(file, "utf8");
    for (const specifier of collectSpecifiers(source)) {
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      if (path.isAbsolute(specifier) || specifier.startsWith("/")) continue;
      if (PROVIDED.has(specifier)) continue;
      const name = packageName(specifier);
      if (devDependencies.has(name)) {
        problems.push(`${relativePath}: ships an import of devDependency '${name}'`);
      }
    }
  }

  // Tests must stay out of the compile, or their devDependency imports end up
  // in out/ and into the VSIX.
  const tsconfig = JSON.parse(await readFile(path.join(PROJECT_ROOT, "tsconfig.json"), "utf8"));
  const excludes = tsconfig.exclude ?? [];
  if (!excludes.some((entry) => String(entry).replace(/^\.\//, "") === "src/test")) {
    problems.push("tsconfig.json: 'exclude' must contain 'src/test' so tests are not compiled");
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`shipped-imports: ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `shipped-imports: OK (${devDependencies.size} devDependencies, none imported by shipped source)`,
  );
}

await main();
