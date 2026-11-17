// The one place that decides which page controls a fill may press.
//
// A fill writes answers; it never moves the application on. Submitting,
// going to the next step and signing are the applicant's own presses, so a
// click made while filling is refused whenever it would land on one of
// these, whichever path makes it: a site rule's action (interpreter.ts), the
// content script's own picks (content.ts) or a real click sent through the
// debugger (bridge.ts). mainWorld.ts runs serialized in the page and cannot
// import this module; it keeps its own copy of these patterns, and
// tests/click-gate.test.ts checks the two agree.

export type ControlKind = "submit" | "navigation" | "signature" | "other";

// Sends the application, or starts a new one.
export const submitPattern =
  /\b(submit|send|finish)\b|\bcomplete (?:my |your |the )?application\b|\bapply (?:now|for (?:this )?(?:job|position|role))\b/i;
// Signs or certifies on the applicant's behalf.
export const signaturePattern =
  /\b(sign|e-?sign|agree|attest|certify|certification)\b/i;
// Moves to another step: "Next", "Continue", "Save and Continue", "Review
// application". A calendar's or a list's own "Next month" / "Next page" is
// not a step of the application.
export const navigationPattern =
  /\b(next|continue|proceed)\b(?!\s+(?:month|year|week|day|decade|page|image|photo|slide|results?|options?|items?|entr(?:y|ies))\b)|\bsave (?:and|&) (?:continue|next|proceed)\b|\breview (?:and submit|(?:my |your |the )?application)\b/i;
// A button's name is short; a longer text holding "next" is an answer
// ("I can start within the next two weeks"), not a step button.
const navigationLabelLimit = 30;

export function controlKind(label: string): ControlKind {
  const text = label.replace(/\s+/g, " ").trim();
  if (!text) return "other";
  if (submitPattern.test(text)) return "submit";
  if (signaturePattern.test(text)) return "signature";
  if (text.length <= navigationLabelLimit && navigationPattern.test(text)) return "navigation";
  return "other";
}

export function defaultControlLabel(element: Element): string {
  return (
    element.getAttribute("aria-label") ||
    [...((element as HTMLInputElement).labels || [])].map((label) => label.textContent || "").join(" ") ||
    element.textContent ||
    (element as HTMLInputElement).value ||
    ""
  )
    .replace(/\s+/g, " ")
    .trim();
}

const pressable = 'button,a,[role="button"],[role="link"],input[type="button"],input[type="submit"],input[type="image"]';

// The submit, navigation or signing control a click on `element` would press:
// the element itself or any control it sits in, across shadow roots.
// Undefined when the click presses none.
export function pressedControl(
  element: Element,
  labelOf: (element: Element) => string = defaultControlLabel,
): { kind: Exclude<ControlKind, "other">; control: Element } | undefined {
  for (
    let node: Element | null = element;
    node;
    node = node.parentElement || ((node.getRootNode() as ShadowRoot).host ?? null)
  ) {
    if (node.matches('input[type="submit"],input[type="image"]')) return { kind: "submit", control: node };
    if (!node.matches(pressable)) continue;
    const kind = controlKind(labelOf(node));
    if (kind !== "other") return { kind, control: node };
  }
  return undefined;
}

export const refusedMessage: Record<Exclude<ControlKind, "other">, string> = {
  submit: "Refused to activate a submit or certification control.",
  signature: "Refused to activate a submit or certification control.",
  navigation: "Refused to press a Next or Continue control while filling.",
};

// Throws when a fill's click would press a submit, navigation or signing
// control; otherwise clicks.
export function fillClick(element: Element | null | undefined) {
  if (!element) return;
  const pressed = pressedControl(element);
  if (pressed) throw new Error(refusedMessage[pressed.kind]);
  (element as HTMLElement).click();
}

// The element a real (debugger) click at this point of the viewport would
// reach, inside open shadow roots too.
export function elementAtPoint(root: Document, x: number, y: number): Element | undefined {
  let found = root.elementFromPoint(x, y) || undefined;
  while (found?.shadowRoot) {
    const inner = found.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === found) break;
    found = inner;
  }
  return found;
}

// Whether a real click at this point may be sent while filling. Only the top
// frame can say: the debugger's coordinates are the tab's, not a frame's.
export function clickPointAllowed(point: { x: number; y: number }, root: Document = document): boolean {
  if (root.defaultView && root.defaultView !== root.defaultView.top) return true;
  const target = elementAtPoint(root, point.x, point.y);
  if (!target) return false;
  if (pressedControl(target)) return false;
  return !isFormSubmitButton(target);
}

function isFormSubmitButton(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement)
    if (node instanceof HTMLButtonElement && node.type === "submit" && node.form) return true;
  return false;
}

// Whether a real Enter on this focused element can only pick from its own
// list: never on a control that submits or moves on, and in a form only on a
// combobox-like field, where a plain text box would submit the form.
export function enterAllowed(element: Element): boolean {
  if (pressedControl(element) || isFormSubmitButton(element)) return false;
  const listLike =
    element.matches(
      '[role="combobox"],[role="spinbutton"],[role="listbox"],[aria-autocomplete],[aria-haspopup],[aria-expanded],[aria-controls],[aria-activedescendant]',
    ) || Boolean(element.closest('[role="combobox"]'));
  if (listLike) return true;
  return !(element as HTMLInputElement).form && !element.closest("form");
}
