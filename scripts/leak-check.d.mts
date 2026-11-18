import type { LeakTerm, Line } from "../src/server/leak-terms.mjs";
export type { LeakTerm, Line };
export { collectTerms, findLeaks, matcher } from "../src/server/leak-terms.mjs";
export declare function dataDirectory(env?: Record<string, string | undefined>, cwd?: string, platform?: string, home?: string, checkout?: string): string;
export declare function loadTerms(dir: string, options?: { commits?: boolean }): LeakTerm[];
export declare function addedLines(diff: string): Line[];
export declare function listedFileLines(dir: string, files: string[]): Line[];
export declare function leakHits(dir: string, files: string[], dataDir?: string): { terms: number; hits: Array<{ where: string; kind: string; term: string }> };
