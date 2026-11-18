import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename, delimiter, extname, join } from "node:path";

// Starting a program by name on Windows. Node starts only .exe files there:
// a bare "codex" or "npm" is not found, because npm installs its CLIs as
// .cmd scripts, and a .cmd runs only through cmd.exe. Elsewhere, and for an
// .exe, the command is returned as it was given.

const windows = process.platform === "win32";
const scripts = new Set([".cmd", ".bat"]);
const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// The file Windows would run for this command: in each PATH folder (or at
// the path given) an .exe before a script, as PATHEXT orders them.
function found(command: string): string | undefined {
  if (extname(command)) return command;
  const folders = /[\\/]/.test(command) ? [""] : (process.env.PATH || "").split(delimiter).filter(Boolean);
  for (const folder of folders)
    for (const extension of [".exe", ".cmd", ".bat"]) {
      const candidate = `${folder ? join(folder, command) : command}${extension}`;
      if (isFile(candidate)) return candidate;
    }
}

// cmd.exe's own quoting, as cross-spawn does it: the argument is quoted for
// the program that finally reads it, then every character cmd.exe acts on is
// escaped, twice, because a script that passes %* on has it parsed again.
const meta = /([()\][%!^"`<>&|;, *?])/g;
const quoted = (argument: string) => {
  const inner = argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${inner}"`.replace(meta, "^$1").replace(meta, "^$1");
};

export type Launch = { command: string; args: string[]; windowsVerbatimArguments?: boolean };

export function launch(command: string, args: string[]): Launch {
  if (!windows) return { command, args };
  const file = found(command);
  // Not found stays as given, so the caller sees the usual ENOENT.
  if (!file) return { command, args };
  if (!scripts.has(extname(file).toLowerCase())) return { command: file, args };
  // cmd.exe ends a command at a line break: the rest would be lost silently.
  if (args.some((argument) => /[\r\n]/.test(argument)))
    throw new Error(`${basename(file)} is a script, which cannot be given an argument of several lines on Windows.`);
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${[file.replace(meta, "^$1"), ...args.map(quoted)].join(" ")}"`],
    windowsVerbatimArguments: true,
  };
}

// Stops a process and everything it started. Windows has no process groups
// to signal and no graceful stop for a tree: taskkill ends it outright. Other
// systems signal the group, which the process must lead (spawned detached).
export function stopTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  if (windows) spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
  else process.kill(-pid, signal);
}

// Process groups the backend started (a drafting CLI, the LaTeX engine's
// Python and the pdflatex under it): stopped whole when their work is
// cancelled, and any still running when the backend exits. In their own
// group they no longer get the terminal's Ctrl+C, so this is what stops them.
const groups = new Set<number>();
export function trackGroup(pid: number | undefined) {
  if (pid) groups.add(pid);
}
export function untrackGroup(pid: number | undefined) {
  if (pid) groups.delete(pid);
}
export function stopGroup(pid: number | undefined) {
  if (!pid || !groups.has(pid)) return;
  groups.delete(pid);
  try {
    stopTree(pid);
  } catch {
    /* Already gone. */
  }
}
process.once("exit", () => {
  for (const pid of [...groups]) stopGroup(pid);
});
