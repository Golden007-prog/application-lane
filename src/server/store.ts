import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveDataDirectory } from "./paths";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  emptyProfile,
  profileSchema,
  type GenerationJob,
  type Profile,
} from "../shared/model";

export const providerKindSchema = z.enum(["http", "claude-cli", "codex-cli"]);
export const draftProviderSchema = z.object({
  // Stable IDs distinguish two logins that use the same CLI.
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: z.string().min(1).max(60).optional(),
  provider: providerKindSchema,
  model: z.string().min(1).max(100),
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  timeoutMs: z.number().int().min(1000).max(180_000).optional(),
  // A separate Codex home keeps two logins' authentication independent.
  home: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
});
export type DraftProviderConfig = z.infer<typeof draftProviderSchema>;
const draftProvidersSchema = z.array(draftProviderSchema).max(8).superRefine((providers, context) => {
  const seen = new Set<string>();
  providers.forEach((provider, index) => {
    if (seen.has(provider.id))
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "id"], message: "Provider IDs must be unique." });
    seen.add(provider.id);
  });
});

const configObject = z.object({
  token: z.string().min(32),
  extensionId: z
    .string()
    .regex(/^[a-p]{32}$/)
    .optional(),
  endpoint: z.string().url().default("https://api.openai.com/v1"),
  model: z.string().default(""),
  apiKey: z.string().default(""),
  generationConcurrency: z.number().int().min(1).max(4).default(2),
  // The most model requests one drafting job may make (an application's
  // step: its letter, answers, checks and retries, and every provider tried
  // for each). An application takes about 7-15; the limit stops a loop of
  // failures and retries from spending a subscription's usage.
  draftCallLimit: z.number().int().min(5).max(500).default(40),
  fontPath: z.string().optional(),
  // A checkout of the applicant's own LaTeX resume sources. When set, the
  // resume PDF is compiled from the variant that fits the posting instead of
  // being laid out here.
  resumeLatexDir: z.string().optional(),
  // The applicant's tailoring folder: resumes/*.tex, profile.md,
  // preferences.md and references/*.md. When set, the engine in tailor/
  // tailors the resume (reordered LaTeX plus one rewritten summary line),
  // builds the cover letter PDF under the resume's letterhead, and answers
  // are written from the notes. Replaces resumeLatexDir. The backend's entry
  // point defaults it to <data directory>/tailoring when that exists
  // (npm run tailoring:import). "jobApplierDir", a job-applier checkout in
  // its own layout, is still read as this.
  tailorDir: z.string().optional(),
  // Draft through a logged-in Claude Code or Codex CLI instead of the
  // endpoint above, which then serves only as the fallback when the CLI
  // fails (not logged in, over its usage limit, too slow).
  provider: providerKindSchema.default("http"),
  // Defaults: sonnet for claude-cli; for codex-cli, the Codex CLI's own
  // configured model.
  cliModel: z.string().optional(),
  // Claude tries the logged-in Codex CLI before the HTTP endpoint.
  codexFallback: z.boolean().default(false),
  // Empty: the Codex CLI's own configured model.
  codexFallbackModel: z.string().default(""),
  // Codex reasoning effort; low answers in about 20 seconds.
  cliEffort: z.enum(["minimal", "low", "medium", "high"]).default("low"),
  // Ordered drafting policy. Empty keeps legacy provider/codexFallback
  // settings working so existing installations do not need an immediate edit.
  draftProviders: draftProvidersSchema.default([]),
  // Who checks drafted claims, in order, passing over the model that wrote
  // the draft. Empty: the Drafting order, then verifyModel.
  checkProviders: draftProvidersSchema.default([]),
  // Read the job posting from the ATS's public posting endpoint (posting.ts)
  // so documents are tailored from it, not from an application form's text.
  postingLookup: z.boolean().default(true),
  // The endpoint model that checks drafted answers, letters and summaries
  // against the profile. It must not be the drafting model: while a CLI
  // drafts, the endpoint's own model is used when this is empty.
  verifyModel: z.string().default(""),
  // "fast" skips that check: documents are ready sooner, unverified.
  checking: z.enum(["thorough", "fast"]).default("thorough"),
  // Where the applicant keeps their transcript (the newest PDF or DOCX is
  // uploaded to a form's transcript field). Default: transcripts/ in the
  // data folder (beside it for a checkout's .local/ that already has one).
  transcriptsDir: z.string().optional(),
  // Where drafted documents are written as files to upload by hand, one
  // folder per job. The backend's entry point defaults it to
  // ~/Documents/Application Lane; unset, nothing is written.
  documentsDir: z.string().optional(),
});
// The key this folder had while it had to be a job-applier checkout.
export const configSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { jobApplierDir, ...rest } = raw as Record<string, unknown>;
  return jobApplierDir !== undefined && rest.tailorDir === undefined ? { ...rest, tailorDir: jobApplierDir } : rest;
}, configObject);
export type Config = z.infer<typeof configSchema>;
// LANE_DATA_DIR, an existing .local/ installation, or the per-user app-data
// folder (paths.ts).
export const dataDirectory = resolveDataDirectory();
// The applicant's tailoring files, once imported into the data directory,
// need no setting (npm run tailoring:import).
export function withTailoring(config: Config, directory = dataDirectory): Config {
  if (!config.tailorDir && existsSync(join(directory, "tailoring", "resumes")))
    config.tailorDir = join(directory, "tailoring");
  return config;
}
export async function atomicJSON(path: string, value: unknown) {
  const temporary = `${path}.${randomBytes(5).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  // Windows refuses to replace a file another reader has open; it is closed
  // within moments. Unretried, a fixer task's result was lost and the fixer
  // stopped while its loop read the same file.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(code || "")) {
        await rm(temporary, { force: true });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}
export async function readJSON<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}
export type Database = { profile: Profile; jobs: GenerationJob[] };
// The format of state.json this build writes and reads. A file from before
// it was numbered reads as 0. 1: { schemaVersion, profile, jobs }.
export const STATE_VERSION = 1;
export class Store {
  data: Database = { profile: structuredClone(emptyProfile), jobs: [] };
  private pending = Promise.resolve();
  constructor(readonly directory: string) {}
  async init() {
    await mkdir(join(this.directory, "artifacts"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(join(this.directory, "issues"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(join(this.directory, "recordings"), {
      recursive: true,
      mode: 0o700,
    });
    // The data folder and these are the applicant's alone, also when they
    // already existed (a LANE_DATA_DIR made by hand): mkdir's mode applies
    // only to a folder it creates. Windows does not use these modes.
    if (process.platform !== "win32")
      for (const folder of [this.directory, ...["artifacts", "issues", "recordings"].map((name) => join(this.directory, name))])
        await chmod(folder, 0o700).catch(() => { /* best effort: the folder keeps its modes if refused */ });
    const path = join(this.directory, "state.json");
    // The applicant's profile and history: never overwritten unread. A file
    // that cannot be read, or that a newer build wrote, stops the backend
    // with what to do, and is left as it is.
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(`${path} could not be read (${(error as Error).message}). It was left as it is: restore it from a backup beside it, or move it aside to start with an empty profile.`);
    }
    const found = raw && typeof raw === "object" ? raw as Partial<Database> & { schemaVersion?: unknown } : undefined;
    const version = typeof found?.schemaVersion === "number" ? found.schemaVersion : 0;
    if (version > STATE_VERSION)
      throw new Error(`${path} was saved by a newer version of Application Lane (format ${version}; this one reads up to ${STATE_VERSION}). Update Application Lane; the file was left as it is.`);
    if (found) {
      const { schemaVersion: _version, ...data } = found;
      this.data = { ...this.data, ...data } as Database;
    }
    // Whether what is saved changes on load: an older format, or a profile
    // that only loads in part. The file as it was is kept beside it first.
    let changed = Boolean(found) && version !== STATE_VERSION;
    // A legacy or hand-edited profile must not stop the backend from starting.
    // Keep every field that still validates and drop only the ones that do not;
    // a recovered profile always needs reconfirmation before it is used.
    const stored = profileSchema.safeParse(this.data.profile);
    if (stored.success) this.data.profile = stored.data;
    else {
      changed = true;
      const candidate: Record<string, unknown> = {
        ...structuredClone(emptyProfile),
        ...(this.data.profile as object),
        confirmed: false,
      };
      for (let attempt = 0; attempt < 10; attempt++) {
        const result = profileSchema.safeParse(candidate);
        if (result.success) {
          this.data.profile = result.data;
          break;
        }
        const dropped = new Set(
          result.error.issues.map((issue) => String(issue.path[0])),
        );
        for (const key of dropped)
          candidate[key] = (emptyProfile as Record<string, unknown>)[key];
        if (!dropped.size) {
          this.data.profile = structuredClone(emptyProfile);
          break;
        }
      }
    }
    if (changed) {
      const backup = `${path}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await copyFile(path, backup);
      await chmod(backup, 0o600);
    }
    if (!Array.isArray(this.data.jobs)) this.data.jobs = [];
    for (const job of this.data.jobs)
      if (job.status === "queued" || job.status === "running") {
        job.status = "failed";
        job.error = "Backend restarted. Retry to create fresh documents.";
      }
    await this.save();
  }
  save() {
    const snapshot = { schemaVersion: STATE_VERSION, ...structuredClone(this.data) };
    this.pending = this.pending
      .catch(() => { /* an earlier save's failure was already reported to its own caller */ })
      .then(() => atomicJSON(join(this.directory, "state.json"), snapshot));
    return this.pending;
  }
}
