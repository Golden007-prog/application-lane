// A command the service worker sends a frame (content/commands.ts): a snapshot of the page for an issue report.
// Split out of executeCommand as it was.
import { secretName, redactURL } from "../../workspace";
import { fieldLabel } from "../tracking";
import { inspect } from "../inspect";
import { boundSnapshotMarkup } from "../../snapshot-markup";
import { Command } from "../core";

  export async function handleSnapshot(command: Command): Promise<unknown> {
const clone = document.documentElement.cloneNode(true) as HTMLElement;
// A clone leaves shadow roots behind, and with them what web components
// hold (SuccessFactors' date pickers). Each open one is written in as a
// declarative shadow root, as the browser would serialize it.
const shadowRoots: ShadowRoot[] = [];
const collect = (root: Document | ShadowRoot) => {
  for (const element of root.querySelectorAll("*"))
    if (element.shadowRoot) {
      shadowRoots.push(element.shadowRoot);
      collect(element.shadowRoot);
    }
};
collect(document);
const liveElements = [...document.documentElement.querySelectorAll("*")];
const cloneElements = [...clone.querySelectorAll("*")];
liveElements.forEach((element, index) => {
  if (!element.shadowRoot || !cloneElements[index]) return;
  const template = document.createElement("template");
  template.setAttribute("shadowrootmode", "open");
  const root = element.shadowRoot as ShadowRoot & {
    getHTML?: (options: { shadowRoots: ShadowRoot[] }) => string;
  };
  template.innerHTML = root.getHTML ? root.getHTML({ shadowRoots }) : root.innerHTML;
  cloneElements[index].prepend(template);
});
clone.querySelectorAll("script,noscript").forEach((node) => node.remove());
const sensitiveName = secretName;
clone
  .querySelectorAll<HTMLMetaElement>("meta[name]")
  .forEach((meta) => {
    if (sensitiveName.test(meta.name)) meta.setAttribute("content", "[redacted]");
  });
// Inline handlers are page code, not form state, and can embed tokens.
for (const node of clone.querySelectorAll("*"))
  for (const attribute of [...node.attributes])
    if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
for (const attribute of ["href", "src", "action", "formaction"])
  clone.querySelectorAll(`[${attribute}]`).forEach((node) => {
    const value = node.getAttribute(attribute) || "";
    if (/[?#]/.test(value))
      node.setAttribute(attribute, redactURL(new URL(value, location.href).href));
  });
const secretValues = new Set<string>();
const live = [
  ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    "input,textarea,select",
  ),
];
const copies = [
  ...clone.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    "input,textarea,select",
  ),
];
live.forEach((control, index) => {
  const copy = copies[index];
  if (!copy) return;
  const secret =
    (control instanceof HTMLInputElement && control.type === "password") ||
    sensitiveName.test(
      `${control.name} ${control.id} ${fieldLabel(control)}`,
    );
  if (secret && control.value) secretValues.add(control.value);
  const value = secret
    ? "[redacted]"
    : control instanceof HTMLInputElement && control.type === "file"
      ? control.files?.[0]?.name || ""
      : // Hidden fields can hold whole documents (iCIMS keeps the
        // uploaded resume as base64); reports never carry file contents.
        control instanceof HTMLInputElement &&
          control.type === "hidden" &&
          control.value.length > 200
        ? `[omitted ${control.value.length} characters]`
        : control.value;
  copy.setAttribute("data-lane-value", value);
  copy.removeAttribute("value");
  if (copy instanceof HTMLTextAreaElement) copy.textContent = value;
  if (copy instanceof HTMLSelectElement) {
    if (secret) copy.replaceChildren(new Option("[redacted]", "[redacted]"));
    else
      [...copy.options].forEach((option) => {
        if (option.value === value) option.setAttribute("selected", "");
        else option.removeAttribute("selected");
      });
  }
  if (control instanceof HTMLInputElement && control.checked)
    copy.setAttribute("data-lane-checked", "true");
});
const observation = inspect();
observation.fields = observation.fields.map((field) =>
  sensitiveName.test(field.label) || secretValues.has(field.value)
    ? { ...field, value: "[redacted]" }
    : field,
);
observation.url = redactURL(observation.url);
let html = clone.outerHTML;
for (const value of secretValues) {
  observation.description = observation.description.replaceAll(value, "[redacted]");
  // Short values (a PIN, "1") would redact unrelated text.
  if (value.length >= 6) html = html.replaceAll(value, "[redacted]");
}
return {
  observation,
  html: boundSnapshotMarkup(html),
};
}
