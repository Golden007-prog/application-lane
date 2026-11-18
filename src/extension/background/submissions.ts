// Part of the extension's service worker (background.ts): submitted applications and progress.
// Split out of background.ts as it was; see background.ts for how it starts.
import { type Application, activeStatuses } from "../../shared/model";
import { bg } from "./state";
import { api, persist } from "./core";
import { invalidate } from "./run";

// Why the fill stopped for the applicant, naming the event that did it: a
// pause nobody remembers causing could not be traced afterwards.
export const interactedNote = (cause: unknown) =>
  `You interacted with this application${typeof cause === "string" && cause ? ` (${cause.replace(/\s+/g, " ").slice(0, 100)})` : ""}. Choose Fill this step when ready.`;

// An application moves to a stage: by the applicant's choice, or because
// the site showed its confirmation (siteSubmitted).
export const submittedNote = "The site confirmed this application was submitted. Change its stage if that is wrong.";

// The backend's history of applications that went in (SubmissionRecord).
export const submissionRecord = (app: Application) => ({
  applicationId: app.id,
  company: app.company.slice(0, 300),
  title: app.title.slice(0, 500),
  url: app.url.slice(0, 3000),
  ...(app.sourceUrl && app.sourceUrl !== app.url ? { sourceUrl: app.sourceUrl.slice(0, 3000) } : {}),
  ...(app.ats ? { ats: app.ats.slice(0, 200) } : {}),
  submittedAt: app.submittedAt || app.stageUpdatedAt || app.updatedAt,
  confirmedBySite: Boolean(app.confirmedBySite),
});
export async function syncSubmissions() {
  if (bg.submissionsSynced || !bg.token) return;
  const submitted = bg.state.applications.filter((app) => app.workflowStage === "submitted");
  if (submitted.length) await api("/v1/submissions", "POST", { entries: submitted.map(submissionRecord) });
  bg.submissionsSynced = true;
}
// A finished application has nothing left to fill: the note asking for
// Fill this step (left by a profile change) is replaced.
export const finishedStages: Application["workflowStage"][] = ["submitted", "blocked", "abandoned"];
export const finishedNote = (app: Application) =>
  app.workflowStage === "submitted"
    ? app.confirmedBySite ? submittedNote : "Marked submitted."
    : app.workflowStage === "blocked" ? `Blocked${app.blockedReason ? `: ${app.blockedReason}` : "."}` : "Abandoned.";

export function tidyFinishedNotes() {
  for (const app of bg.state.applications)
    if (finishedStages.includes(app.workflowStage) && /Choose Fill this step|Choose another related tab|Scan it, then choose/.test(app.note || ""))
      app.note = finishedNote(app);
}

export async function setStage(app: Application, stage: Application["workflowStage"], reason?: unknown, bySite = false) {
  const was = app.workflowStage;
  if (bySite) app.confirmedBySite = true;
  if (
    ["submitted", "blocked", "abandoned"].includes(stage) &&
    (app.explicitFill || activeStatuses.includes(app.status))
  )
    await invalidate(app, "paused", `Fill paused because this application is now ${stage}.`);
  app.workflowStage = stage;
  app.stageUpdatedAt = Date.now();
  app.blockedReason = stage === "blocked" ? String(reason || "").slice(0, 350) : undefined;
  app.submittedAt = stage === "submitted" ? Date.now() : undefined;
  // Said with the stage, so the card never shows one without the other.
  if (bySite) {
    app.note = submittedNote;
    app.updatedAt = Date.now();
  }
  // The history: added when it goes in, removed when it is moved back out
  // (it was marked by mistake). Kept for a later sync if the backend is away.
  if (stage === "submitted")
    await api("/v1/submissions", "POST", { entries: [submissionRecord(app)] }).catch(() => { bg.submissionsSynced = false; });
  else if (was === "submitted")
    await api(`/v1/submissions/${app.id}`, "DELETE").catch(() => { /* the job or submission is already gone: nothing to remove */ });
  // The documents' folder moves under Sent, and back if this is reopened.
  const documentJob = app.documentJobId || app.jobId;
  if (documentJob && app.artifacts.length)
    await api(`/v1/jobs/${documentJob}/files`, "POST", {
      sent: stage === "submitted",
      company: app.company,
      title: app.title,
    }).catch(() => { /* best effort: the history syncs again on the next pump */ });
  await persist();
}
// The site drew its own "application submitted" page or banner in this
// application's tab (content.ts). The applicant pressed Submit; this only
// saves them marking it. A stage they set themselves afterwards stands.
export async function siteSubmitted(app: Application) {
  if (app.confirmedBySite || !["applying", "review"].includes(app.workflowStage) || app.status === "cancelled") return;
  await setStage(app, "submitted", undefined, true);
}
export function noteProgress(app: Application, label: string) {
  const progress = app.progress || { answered: [] };
  if (progress.current && progress.current !== label && progress.answered.at(-1) !== progress.current)
    progress.answered = [...progress.answered, progress.current].slice(-300);
  progress.current = label;
  app.progress = progress;
  bg.progressTimer ||= setTimeout(() => {
    bg.progressTimer = undefined;
    void persist();
  }, 300);
}
