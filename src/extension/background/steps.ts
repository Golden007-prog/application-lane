// Part of the extension's service worker (background.ts): a step's own Next and Submit, pressed when the applicant asks.
// Split out of background.ts as it was; see background.ts for how it starts.
import { type Application, type StepCheck } from "../../shared/model";
import { bg } from "./state";
import { allFrames, frameCall, persist } from "./core";

// A step's own Next and Submit, found in each frame (STEP_CHECK in
// content.ts) and pressed only when the applicant asks: the panel's Next
// step and Submit, lane next and lane submit. A fill never presses them
// (click-gate.ts). Exactly one of a kind on the page, or none is pressed.
export type StepTarget = { frameId: number; documentId: string; label: string };
export async function checkSteps(app: Application): Promise<{ check: StepCheck; targets: Partial<Record<"next" | "submit", StepTarget>> }> {
  if (app.tabId === undefined) throw new Error("Its tab is closed. Switch to it first.");
  if (["inspecting", "preparing", "filling"].includes(app.status) || app.assisting)
    throw new Error("It is being filled. Try again when it finishes.");
  type Reply = { documentId: string; foreign: boolean; next?: string; nextCount: number; submit?: string; submitCount: number; blockers: string[]; unfinished: string[] };
  const replies = (
    await Promise.all(
      (await allFrames(app.tabId)).map(async (frame) => {
        const reply = (await frameCall(app, frame.frameId, { type: "STEP_CHECK" }).catch(() => undefined)) as Reply | undefined;
        return reply && !reply.foreign ? { ...reply, frameId: frame.frameId } : undefined;
      }),
    )
  ).filter((reply): reply is Reply & { frameId: number } => Boolean(reply));
  if (!replies.length) throw new Error("The page did not answer. Refresh its tab, then try again.");
  const targets: Partial<Record<"next" | "submit", StepTarget>> = {};
  const problems: Partial<Record<"next" | "submit", string>> = {};
  for (const kind of ["next", "submit"] as const) {
    const name = kind === "next" ? "Next" : "Submit";
    const count = replies.reduce((total, reply) => total + (kind === "next" ? reply.nextCount : reply.submitCount), 0);
    const holder = replies.find((reply) => reply[kind]);
    if (count === 1 && holder) targets[kind] = { frameId: holder.frameId, documentId: holder.documentId, label: holder[kind]! };
    else problems[kind] = count
      ? `This page shows ${count} ${name} buttons. Press the right one on the page.`
      : `No ${name} button found on this page.`;
  }
  return {
    targets,
    check: {
      ...(targets.next ? { next: targets.next.label } : { nextProblem: problems.next }),
      ...(targets.submit ? { submit: targets.submit.label } : { submitProblem: problems.submit }),
      blockers: [...new Set(replies.flatMap((reply) => reply.blockers))].slice(0, 10),
      unfinished: replies.flatMap((reply) => reply.unfinished).slice(0, 30),
      aiFilled: (app.aiFilled || []).map((entry) => `${entry.label}: ${entry.value}`.slice(0, 200)),
      notes: app.missing.slice(0, 20),
    },
  };
}
export async function pressStepFor(app: Application, step: "next" | "submit", confirmed?: string): Promise<string> {
  if (step === "next" && bg.state.settings.nextButton === "off")
    throw new Error("Next step is off. Turn it on under Settings → Processing.");
  if (step === "submit" && bg.state.settings.submitButton !== "on")
    throw new Error("Submitting from here is off. Turn it on under Settings → Processing.");
  const { check, targets } = await checkSteps(app);
  const target = targets[step];
  if (!target) throw new Error(step === "next" ? check.nextProblem! : check.submitProblem!);
  // Submit is pressed only as confirmed: the label the applicant was shown.
  if ((step === "submit" || confirmed !== undefined) && confirmed !== target.label)
    throw new Error(`The ${step === "next" ? "Next" : "Submit"} button now says "${target.label}". Check again.`);
  if (check.blockers.length) throw new Error(check.blockers[0]);
  if (check.unfinished.length) throw new Error(`Finish this step first: ${check.unfinished.slice(0, 3).join("; ")}.`);
  await frameCall(app, target.frameId, { type: "PRESS_STEP", documentId: target.documentId, step, label: target.label });
  app.note = step === "next"
    ? `Pressed "${target.label}". Choose Fill this step on the next page.`
    : `Pressed "${target.label}". Mark it submitted once the site confirms.`;
  await persist();
  return app.note;
}
