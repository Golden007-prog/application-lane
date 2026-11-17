// A form step's own Next and Submit controls, found and pressed only when
// the applicant asks (the panel's Next step / Submit, lane next / lane
// submit), never by a fill: a fill's clicks go through click-gate.ts, which
// refuses both.

import { controlKind, defaultControlLabel } from "./click-gate";

export type StepKind = "next" | "submit";

// What the control says, as compared: "Next →" and "Submit application."
// are "Next" and "Submit application".
export function stepLabel(element: Element): string {
  const raw = element instanceof HTMLInputElement ? element.value || element.getAttribute("aria-label") || "" : defaultControlLabel(element);
  return raw.replace(/\s+/g, " ").replace(/[\s!.:›»→>]+$/, "").trim();
}

// Only these exact wordings count. A longer or vaguer one ("Save and finish
// later", "Send code", "Review and submit") is left for the applicant to
// press on the page.
const nextLabel =
  /^(next|next step|continue|continue to next step|save and continue|save & continue|save and next|save & next|proceed|review|review application|review my application)$/i;
const submitLabel =
  /^(submit|submit (my |your |this )?application|send (my |your )?application|complete (my |your )?application|finish application|submit and finish|apply|apply now)$/i;

const candidates = 'button,a[href],[role="button"],input[type="submit"],input[type="button"]';

function usable(element: Element): boolean {
  if (!(element as HTMLElement).getClientRects().length) return false;
  if ((element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true") return false;
  return !element.closest('[hidden],[aria-hidden="true"],[inert]');
}

export function stepKindOf(element: Element): StepKind | undefined {
  const label = stepLabel(element);
  if (!label) return undefined;
  // A wording that also signs or agrees ("Agree and continue") is the
  // applicant's own press, whatever else it does.
  const kind = controlKind(label);
  if (nextLabel.test(label) && kind === "navigation") return "next";
  if (submitLabel.test(label) && kind === "submit") return "submit";
  return undefined;
}

// The step controls this document shows, each kind in page order. A control
// inside another found one counts once.
export function stepControls(root: Document, preferredNext?: string): Record<StepKind, Element[]> {
  const found: Record<StepKind, Element[]> = { next: [], submit: [] };
  const preferred = preferredNext ? [...root.querySelectorAll(preferredNext)].filter(usable) : [];
  const all = [...root.querySelectorAll(candidates)].filter(usable);
  for (const element of all) {
    if (all.some((other) => other !== element && other.contains(element))) continue;
    const kind = stepKindOf(element);
    if (kind) found[kind].push(element);
  }
  // The site's own Next (an adapter's selector) settles which of several it is.
  const preferredNextFound = preferred.filter((element) => stepKindOf(element) === "next");
  if (preferredNextFound.length === 1) found.next = preferredNextFound;
  return found;
}

// Presses the control after checking, at the moment of pressing, that it is
// still the one the applicant chose.
export function pressStep(element: Element, kind: StepKind, label: string) {
  if (!element.isConnected || !usable(element)) throw new Error("The button is no longer on the page.");
  if (stepKindOf(element) !== kind) throw new Error("That button no longer says what it said. Check the page.");
  if (stepLabel(element) !== label) throw new Error(`The button now says "${stepLabel(element)}". Check the page.`);
  (element as HTMLElement).click();
}
