// A command the service worker sends a frame (content/commands.ts): recording what happens on the page.
// Split out of executeCommand as it was.
import { cs } from "../state";
import { fieldLabel } from "../tracking";
import { type Control } from "../../semantics";
import { startRecorder } from "../../recorder";
import { tell } from "../../content-dom";
import { valueOf } from "../controls";
import { secretName, redactURL } from "../../workspace";
import { inspect } from "../inspect";
import { Command } from "../core";

  export async function handleRecordStart(command: Command): Promise<unknown> {
const session = String(command.session || "");
// Already recording this session in this document: keep going.
if (cs.stopRecording && cs.recordingSession === session) return { recording: true };
cs.stopRecording?.();
cs.recordingSession = session;
const labelOf = (element: Element) => {
  try {
    return fieldLabel(element as Control);
  } catch {
    return element.getAttribute("aria-label") || "";
  }
};
cs.stopRecording = startRecorder({
  session,
  startedAt: Number(command.startedAt) || Date.now(),
  send: (events) => tell({ type: "RECORD_EVENTS", session, events }),
  label: labelOf,
  value: (element) => {
    try {
      return valueOf(element as Control).slice(0, 300);
    } catch {
      return undefined;
    }
  },
  secret: (element) =>
    (element instanceof HTMLInputElement && element.type === "password") ||
    secretName.test(
      `${element.getAttribute("name") || ""} ${element.id} ${labelOf(element)}`,
    ),
  fields: () =>
    inspect().fields.map((field) => ({
      label: field.label,
      kind: field.kind,
      value:
        /password/.test(field.kind) || secretName.test(field.label)
          ? "[redacted]"
          : field.value.slice(0, 300),
    })),
  redactURL,
});
return { recording: true };
}

  export async function handleRecordCheckpoint(command: Command): Promise<unknown> {
return { events: cs.stopRecording?.checkpoint() || [] };
}

  export async function handleRecordStop(command: Command): Promise<unknown> {
const events = cs.stopRecording?.() || [];
cs.stopRecording = undefined;
cs.recordingSession = "";
return { events };
}
