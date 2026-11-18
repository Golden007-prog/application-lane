export type LeakTerm = { term: string; kind: string; cased?: boolean; digits?: boolean; named?: boolean };
export type Line = { where: string; line: string };
export declare function collectTerms(input?: { profile?: Record<string, any>; applications?: Array<Record<string, any>>; extra?: string[]; allow?: string[] }): LeakTerm[];
export declare function matcher(term: LeakTerm): RegExp;
export declare function findLeaks(lines: Line[], terms: LeakTerm[]): Array<{ where: string; kind: string; term: string }>;
