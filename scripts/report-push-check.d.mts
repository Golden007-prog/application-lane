export declare function reportFix(message: string): boolean;
export declare function refusals(lines: string[], git: (args: string[]) => string): { sha: string; message: string }[];
