// The project's own lint, on the TypeScript compiler's syntax tree (no
// extra dependency). Run by `npm run lint` and CI.
//
// - A catch block that does nothing says why in a comment: an error dropped
//   without one reads as an oversight, and the next reader cannot tell.
//
//   node scripts/lint.mjs [<file or folder>…]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["src", "scripts", "tests"];
const skip = new Set(["node_modules", "dist", ".fixer", "test-results", "playwright-report"]);
const source = /\.(ts|tsx|mts|mjs|js)$/;

function files(path) {
  if (statSync(path).isFile()) return source.test(path) ? [path] : [];
  return readdirSync(path).flatMap((name) => (skip.has(name) || name.startsWith(".") ? [] : files(join(path, name))));
}

// What a file breaks: { line, rule, message }.
export function lint(text, name = "file.ts") {
  const kind = name.endsWith(".tsx") ? ts.ScriptKind.TSX : name.endsWith(".ts") || name.endsWith(".mts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kind);
  const problems = [];
  const visit = (node) => {
    if (ts.isCatchClause(node) && node.block.statements.length === 0) {
      // Any comment between the braces is the reason.
      const inside = text.slice(node.block.getStart(file) + 1, node.block.getEnd() - 1);
      if (!/\/\/|\/\*/.test(inside)) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
        problems.push({ line: line + 1, rule: "empty-catch", message: "an empty catch block: say in a comment why the error is dropped" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return problems;
}

if (process.argv[1] && /lint\.mjs$/.test(process.argv[1])) {
  let count = 0;
  for (const path of roots.flatMap(files)) {
    for (const problem of lint(readFileSync(path, "utf8"), path)) {
      console.error(`${relative(process.cwd(), path)}:${problem.line}  ${problem.rule}  ${problem.message}`);
      count++;
    }
  }
  if (count) {
    console.error(`\n${count} problem${count === 1 ? "" : "s"}`);
    process.exitCode = 1;
  } else console.log("lint: clean");
}
