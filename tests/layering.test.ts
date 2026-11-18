import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { test } from "node:test";

// Imports go one way (docs/code-map.md): shared imports no other layer;
// engine imports shared only; extension and server import engine and shared,
// never each other; nothing under src/ imports from scripts/. The site
// rules' JSON tables (src/engine/config/*.json) are data any layer may read.

const layers = ["shared", "engine", "extension", "server"] as const;
type Layer = (typeof layers)[number] | "scripts" | "other";
const may: Record<(typeof layers)[number], Layer[]> = {
  shared: ["shared"],
  engine: ["engine", "shared"],
  extension: ["extension", "engine", "shared"],
  server: ["server", "engine", "shared"],
};

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(tsx?|mjs)$/.test(name) && !name.endsWith(".d.mts") ? [path] : [];
  });
const layerOf = (path: string): Layer => {
  const [top, layer] = normalize(path).split(/[\\/]/);
  if (top === "scripts") return "scripts";
  return top === "src" && (layers as readonly string[]).includes(layer) ? (layer as Layer) : "other";
};
const data = (path: string) => /^src[\\/]engine[\\/]config[\\/].*\.json$/.test(normalize(path));

export function crossings(): string[] {
  const found: string[] = [];
  for (const file of files("src")) {
    const from = layerOf(file) as (typeof layers)[number];
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^"'`;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = match[1] || match[2];
      if (!spec.startsWith(".")) continue;
      const target = relative(".", join(dirname(file), spec));
      if (data(target)) continue;
      const to = layerOf(target);
      if (!may[from].includes(to)) found.push(`${file} (${from}) imports ${target} (${to})`);
    }
  }
  return found;
}

test("each layer imports only the layers below it", () => {
  assert.deepEqual(crossings(), []);
});
