import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";

// The extension and the backend agree on their routes: every api(path,
// method) call the extension makes names a route src/server/app.ts answers,
// with that method. A route renamed or moved on one side only otherwise
// shows up as a 404 in someone's fill.

const sample = "00000000-0000-4000-8000-000000000000";

type Call = { where: string; method: string; path: string };
function extensionCalls(): { calls: Call[]; dynamic: string[] } {
  const calls: Call[] = [];
  const dynamic: string[] = [];
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
    });
  for (const file of files("src/extension")) {
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "api" && node.arguments.length) {
        const [first, second] = node.arguments;
        const where = `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
        const read = (node: ts.Expression): string[] | undefined => {
          if (ts.isStringLiteralLike(node)) return [node.text];
          if (ts.isTemplateExpression(node)) return [node.head.text + node.templateSpans.map((span) => sample + span.literal.text).join("")];
          if (ts.isConditionalExpression(node)) {
            const [yes, no] = [read(node.whenTrue), read(node.whenFalse)];
            return yes && no ? [...yes, ...no] : undefined;
          }
          if (ts.isParenthesizedExpression(node)) return read(node.expression);
          return undefined;
        };
        const paths = read(first);
        const method = !second ? "GET" : ts.isStringLiteralLike(second) ? second.text : undefined;
        if (paths === undefined || method === undefined) dynamic.push(where);
        else for (const path of paths) calls.push({ where, method, path: path.split("?")[0] });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { calls, dynamic };
}

type Route = { path: string | RegExp; methods: Set<string> };
function serverRoutes(): Route[] {
  const lines = readFileSync("src/server/app.ts", "utf8").split("\n");
  const routes: Route[] = [];
  let current: Route | undefined;
  for (const line of lines) {
    const literal = [...line.matchAll(/path === "(\/v1\/[^"]*)"(?:\s*&&\s*req\.method === "(\w+)")?/g)];
    const pattern = line.match(/path\.match\(\/(\^.*?\$)\/\)/);
    if (pattern) {
      current = { path: new RegExp(pattern[1].replace(/\\\//g, "/")), methods: new Set() };
      routes.push(current);
      continue;
    }
    if (literal.length) {
      for (const match of literal) routes.push({ path: match[1], methods: new Set(match[2] ? [match[2]] : []) });
      current = undefined;
      continue;
    }
    // A pattern's methods are checked in the lines after it.
    if (current) for (const match of line.matchAll(/req\.method === "(\w+)"/g)) current.methods.add(match[1]);
  }
  return routes;
}

test("every route the extension calls is one the backend answers, with that method", () => {
  const { calls, dynamic } = extensionCalls();
  const routes = serverRoutes();
  assert.ok(calls.length > 40, `only ${calls.length} api calls found: did the helper's name or shape change?`);
  assert.ok(routes.length > 40, `only ${routes.length} routes found in app.ts: did its shape change?`);
  // Only the service worker's relay passes on a path and method it was
  // given (the panel's own calls, read here where the panel makes them).
  assert.deepEqual(dynamic.filter((where) => !where.startsWith(join("src/extension/background/ui.ts"))), [], "api calls whose path or method this test cannot read");
  const unanswered = calls
    .filter((call) => {
      const matching = routes.filter((route) => (typeof route.path === "string" ? route.path === call.path : route.path.test(call.path)));
      // A route checked with no method (the handshake) answers any.
      return !matching.some((route) => !route.methods.size || route.methods.has(call.method));
    })
    .map((call) => `${call.method} ${call.path} (${call.where})`);
  assert.deepEqual(unanswered, []);
});

test("the contract check notices a route the backend does not have", () => {
  const routes = serverRoutes();
  const answered = (method: string, path: string) =>
    routes.some((route) => (typeof route.path === "string" ? route.path === path : route.path.test(path)) && (!route.methods.size || route.methods.has(method)));
  assert.equal(answered("GET", "/v1/profile"), true);
  assert.equal(answered("GET", `/v1/jobs/${sample}`), true);
  assert.equal(answered("GET", "/v1/no-such-route"), false);
  assert.equal(answered("PATCH", "/v1/profile"), false);
});
