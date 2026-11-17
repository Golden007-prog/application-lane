// Part of the content script (content.ts): the commands the service worker sends a frame.
// Split out of content.ts as it was; see content.ts for how it starts.
import { draftOnlySite, DRAFT_ONLY_NOTE } from "../../shared/matching";
import { CONTENT_VERSION, type Observation } from "../../shared/model";
import { configEngineEnabled } from "../../engine/mode";
import { PAGE_TIMER_EVENT } from "../../engine/page/timers";
import { currentFileName, sectionFor, type Control, writable, replacesForm, uploadError } from "../semantics";
import { fillClick } from "../../engine/page/click-gate";
import { clip, radioGroup, tell, menuEntries, entryPoint, controlledList, drawnOptions, pressOutside, picksOf, ashbyToggle, ripplingSelect } from "../content-dom";
import { secretName, redactURL } from "../workspace";
import { startRecorder } from "../recorder";
import { boundSnapshotMarkup } from "../snapshot-markup";
import { stepControls, stepLabel, pressStep } from "../../engine/page/step-controls";
import { adapterFor } from "../adapters";
import { authorizeMainWorld, requestMainWorld } from "../../engine/page/bridge";
import { configPassTimeout } from "../../shared/timing";
import { signatureField, signingAllowed } from "../../engine/page/signatures";
import { fillDocument } from "../../engine/runtime";
import { fetchSiteOptions } from "../../engine/config/options-source";
import { clicksAround } from "../../engine/config/interpreter";
import { pickMonth } from "../../engine/page/month-picker";
import { type QuestionnaireAnswers, loadQuestionnaires, questionnaireUrls } from "../../engine/config/workday-questionnaire";
import { cs } from "./state";
import { Command, INVISIBLE_CAPTCHA, RecordEntry, listButton, pause, pickerBox, requestTrustedType } from "./core";
import { inspect } from "./inspect";
import { addLock, attentionSpan, awaitSiteSave, documentId, fieldLabel, lockOrigins, lockedLabels, nodeRecords, ownLabel, records, userAttention } from "./tracking";
import { adoptSiteValue, clearPendingWrites, controlsWithin, expectOwnedActivation, hasEditLock, lockReason, markEngineWrite, trackLocalControls, valueOf } from "./controls";
import { changed, guard, guardedRecord, invalidCommandReason, valid } from "./guards";
import { checkControl, listedPosition, reactSelect, reactSelectInput, typeTrusted } from "./choose";
import { apply } from "./apply";

export async function executeCommand(command: Command): Promise<unknown> {
  // The last line of defence for a draft-only site: whatever asked, this
  // page is not written to, opened or advanced.
  if (draftOnlySite(location.href) && /^(APPLY|ATTACH|CONFIG_FILL|PRESS_STEP|REMOVE_ROW|OPTIONS)$/.test(command.type))
    throw new Error(DRAFT_ONLY_NOTE);
  if (command.type === "ENGINE_INFO")
    return { version: CONTENT_VERSION, configEngine: configEngineEnabled };
  // While a fill runs, a hidden page's own timers are run when due
  // (engine/page/timers.ts): this frame's clock, which Chrome does not slow,
  // calls them a few times a second.
  if (command.type === "PAGE_TIMERS") {
    cs.pageTimersOn = Boolean(command.on);
    if (cs.pageTimersOn && !cs.pumpingPageTimers) {
      cs.pumpingPageTimers = true;
      void (async () => {
        try {
          while (cs.pageTimersOn) {
            await pause(100);
            if (cs.pageTimersOn && document.visibilityState === "hidden")
              document.dispatchEvent(new Event(PAGE_TIMER_EVENT));
          }
        } finally {
          cs.pumpingPageTimers = false;
        }
      })();
    }
    return { on: cs.pageTimersOn };
  }
  if (command.type === "INSPECT") return inspect();
  // Whether a file of this name is attached in an upload slot: its name
  // shown beside a control that removes it (Greenhouse's "Remove file",
  // Oracle's "Remove Resume"). A list of earlier uploads to pick from
  // ("Use") names files that are not attached.
  if (command.type === "ATTACHED") {
    const name = (command.name || "").trim();
    const removes = (element: Element) =>
      [element.textContent, element.getAttribute("aria-label"), element.getAttribute("title")].some((text) =>
        // Workday's is "Delete".
        /^\s*(remove|delete)\b/i.test(text || ""),
      );
    // Only a file the applicant can see is attached: one employer's Oracle keeps
    // the cover letter and its "Remove Cover Letter" button in a part of
    // the page that is not shown, and it was taken for the one in
    // Additional Documents, which stayed empty.
    const shown = (element: Element) =>
      (element as HTMLElement).getClientRects().length > 0 &&
      (element as HTMLElement).checkVisibility({ visibilityProperty: true, opacityProperty: true });
    const named = name
      ? [...document.querySelectorAll("body *")].filter(
          (element) => !element.childElementCount && (element.textContent || "").trim() === name && shown(element),
        )
      : [];
    // A site that takes the file into a list of its own names it as that
    // list's choice: Microsoft's "Upload your resume" box held the name,
    // and the résumé was sent again on each fill, its parse emptying the
    // address typed before it.
    const chosen = Boolean(name) && [...document.querySelectorAll<HTMLInputElement>('input[role="combobox"]')]
      .some((box) => box.value.trim() === name && shown(box));
    // SmartRecruiters' dropzone lists its upload in its files attribute,
    // the name drawn in its shadow root.
    const dropped = Boolean(name) && [...document.querySelectorAll("spl-dropzone")].some((zone) => {
      const input = zone.shadowRoot?.querySelector('input[type="file"]');
      return shown(zone) && Boolean(input) && currentFileName(input as HTMLInputElement).split(", ").includes(name);
    });
    return {
      attached: chosen || dropped || named.some((element) => {
        let scope: Element | null = element;
        for (let depth = 0; scope && depth < 4; depth++, scope = scope.parentElement)
          if ([...scope.querySelectorAll('button, a, [role="button"]')].some((control) => control !== element && removes(control)))
            return true;
        return false;
      }),
    };
  }
  if (
    command.type === "UNLOCK" &&
    command.applicationId === cs.applicationId
  ) {
    // Forget edit locks on this page. Fields with a value stay protected
    // (they are never overwritten); empty ones may be filled again.
    lockedLabels.clear();
    lockOrigins.clear();
    for (const record of records.values()) {
      record.failedOperation = undefined;
      if (!valueOf(record.element)) {
        record.protected = false;
        record.protectedBy = undefined;
      }
    }
    return inspect();
  }
  if (
    command.type === "REMOVE_ROW" &&
    command.applicationId === cs.applicationId
  ) {
    // A row the site added from a parsed resume, removed with the site's
    // own "Delete Education (3)" control. Nothing else is ever clicked.
    const section = String(command.section || "");
    // iCIMS' group loop: its own "Remove Additional" button takes the last
    // block off in the page's script and never posts the form, and is used
    // only where the page says to keep the highest degree alone.
    if (command.groupLoop) {
      const member = [...records.values()].find((record) => {
        const place = sectionFor(record.element);
        return place.section === section && place.index === Number(command.index);
      })?.element;
      const loop = member?.closest<HTMLElement>(".icims_group_loop[data-group-loop-name]");
      const name = loop?.getAttribute("data-group-loop-name") || "";
      const same = [...document.querySelectorAll(".icims_group_loop[data-group-loop-name]")]
        .filter((other) => other.getAttribute("data-group-loop-name") === name);
      const remover = [...document.querySelectorAll<HTMLInputElement>("input.group-loop-remove[data-group-loop]")]
        .find((input) => input.getAttribute("data-group-loop") === name);
      const form = loop?.closest("form");
      const saysSo = same.some((other) => /\bremove all others\b/i.test(other.textContent || ""));
      if (!loop || !remover || !form || same.length < 2 || same.at(-1) !== loop || !saysSo ||
          remover.disabled || remover.getClientRects().length === 0)
        return { removed: false };
      // Whatever the page's script does, this click never posts the form.
      const hold = (event: Event) => event.preventDefault();
      form.addEventListener("submit", hold, true);
      cs.writing = true;
      try {
        // The one submit input a fill presses, and so not through
        // fillClick (click-gate.ts), which refuses every submit input:
        // iCIMS' own "Remove Additional", only where the page says to
        // remove the others, with the form's submission held above.
        remover.click();
      } finally {
        cs.writing = false;
        for (let waited = 0; waited < 1500 && loop.isConnected; waited += 100) await pause(100);
        form.removeEventListener("submit", hold, true);
      }
      return { removed: !loop.isConnected };
    }
    const number = Number(command.index) + 1;
    const wanted = new RegExp(
      `^(delete|remove)\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(?${number}\\)?$`,
      "i",
    );
    const control = [
      ...document.querySelectorAll<HTMLElement>("a[aria-label],button[aria-label],[role='button'][aria-label]"),
    ].find((element) => wanted.test((element.getAttribute("aria-label") || "").trim()));
    if (!control) return { removed: false };
    // A field of that row, to confirm the row is really gone afterwards.
    const member = [...records.values()].find((record) => {
      const place = sectionFor(record.element);
      return place.section === section && place.index === Number(command.index);
    })?.element;
    cs.writing = true;
    try {
      fillClick(control);
    } finally {
      cs.writing = false;
    }
    for (let waited = 0; waited < 1500; waited += 100) {
      await pause(100);
      if (!member || !member.isConnected || member.getClientRects().length === 0)
        return { removed: Boolean(member) };
    }
    return { removed: false };
  }
  if (command.type === "EDITED_ANSWERS") {
    // Answers the applicant (not this extension) put on the page, as
    // candidates for the saved-answer bank.
    const observation = inspect();
    // A native list's value is its option's hidden value (one employer's location
    // "65f5e6fd-…", Tesla's "7_months_or_more"); a saved answer is filled
    // by the text the applicant picked. A radio with no label of its own
    // reads as its hidden value too: that one has no text to keep.
    const shown = (field: Observation["fields"][number]): Observation["fields"][number] => {
      const element = records.get(field.id)?.element;
      if (element instanceof HTMLSelectElement) {
        const option = element.selectedOptions[0];
        return { ...field, value: option ? clip(option.label || option.text) : "" };
      }
      if (element instanceof HTMLInputElement && element.type === "radio") {
        const selected = radioGroup(element).find((candidate) => candidate instanceof HTMLInputElement && candidate.checked);
        return { ...field, value: selected ? ownLabel(selected) : "" };
      }
      return field;
    };
    return observation.fields.map(shown).filter((field) => {
      const record = records.get(field.id);
      return (
        record &&
        !record.automationWritten &&
        field.value &&
        !["file", "password", "hidden"].includes(field.kind) &&
        field.label !== "Unlabelled field" &&
        !secretName.test(field.label) &&
        /^(a real|value changed outside a fill|existing value)/.test(
          record.protectedBy || "",
        )
      );
    });
  }
  if (command.type === "RECORD_START") {
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
  if (command.type === "RECORD_CHECKPOINT") {
    return { events: cs.stopRecording?.checkpoint() || [] };
  }
  if (command.type === "RECORD_STOP") {
    const events = cs.stopRecording?.() || [];
    cs.stopRecording = undefined;
    cs.recordingSession = "";
    return { events };
  }
  if (command.type === "SNAPSHOT") {
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
  if (command.type === "BIND") {
    if (cs.applicationId && command.applicationId !== cs.applicationId && !cs.paused)
      throw new Error("This tab belongs to another active application.");
    if (
      command.applicationId === cs.applicationId &&
      command.operation < cs.operation
    )
      throw new Error("Stale operation.");
    cs.applicationId = command.applicationId;
    // Dependent fields can appear after binding; their defaults follow the
    // same prefilled-value policy as the fields already visible.
    cs.replaceSiteValues = Boolean(command.replaceSiteValues);
    cs.ownWrites = Array.isArray(command.ownWrites) ? command.ownWrites.slice(0, 300) : [];
    clearPendingWrites();
    if (cs.operation !== command.operation) {
      cs.configController.abort();
      cs.configController = new AbortController();
    }
    cs.operation = command.operation;
    for (const key of command.locks || [])
      addLock(key, "an edit saved with this application earlier");
    inspect();
    // What was on the page before this extension wrote anything is the
    // site's (a saved profile, an earlier application, a parsed resume),
    // not an edit of the applicant's, which edit locks protect: the profile
    // may replace it.
    for (const record of records.values()) adoptSiteValue(record);
    for (const record of records.values())
      if (hasEditLock(record.element, record.label)) {
        record.protected = true;
        record.protectedBy = lockReason(record.element, record.label);
      }
    // Binding never silently resumes a human pause.
    return inspect();
  }
  if (
    command.type === "PAUSE" &&
    command.applicationId === cs.applicationId &&
    command.operation >= cs.operation
  ) {
    cs.paused = true;
    cs.configController.abort();
    return { paused: cs.paused };
  }
  if (
    command.type === "RESUME" &&
    command.applicationId === cs.applicationId &&
    command.operation >= cs.operation
  ) {
    cs.operation = command.operation;
    cs.paused = false;
    cs.pausedBy = "";
    clearPendingWrites();
    cs.configController.abort();
    cs.configController = new AbortController();
    return inspect();
  }
  // Next and Submit are the applicant's own presses, made after they
  // looked over (and often edited) the page, which pauses its fill: they
  // check the page themselves rather than the fill's operation.
  // The step's own Next and Submit (step-controls.ts), for the applicant's
  // Next step and Submit in the panel or lane next / lane submit: what
  // this page would press, and what on it is still unfinished. Read only.
  if (command.type === "STEP_CHECK") {
    const snapshot = inspect();
    const controls = stepControls(document, adapterFor(location.href).next || undefined);
    const label = (kind: "next" | "submit") => (controls[kind].length === 1 ? stepLabel(controls[kind][0]) : undefined);
    return {
      documentId,
      // Bound to another application: never pressed for this one.
      foreign: Boolean(cs.applicationId && command.applicationId !== cs.applicationId),
      next: label("next"),
      nextCount: controls.next.length,
      submit: label("submit"),
      submitCount: controls.submit.length,
      // An invisible CAPTCHA runs when Submit is pressed: not a reason to hold it.
      blockers: snapshot.blockers.filter((blocker) => blocker !== INVISIBLE_CAPTCHA),
      unfinished: snapshot.fields
        .filter((f) => (f.required && !f.value) || f.invalid || f.validationWarning)
        .map((f) => (f.required && !f.value ? `${f.label}: empty` : `${f.label}: ${f.validationWarning || "not accepted"}`).slice(0, 160))
        .slice(0, 30),
    };
  }
  // Presses the one control STEP_CHECK named, on the same page, only if it
  // still says what the applicant confirmed and nothing on the step is
  // left unfinished.
  if (command.type === "PRESS_STEP") {
    if (cs.applicationId && command.applicationId !== cs.applicationId) throw new Error("This tab belongs to another application.");
    if (command.documentId !== documentId) throw new Error("The page changed since it was checked. Check it again.");
    const kind = command.step === "submit" ? "submit" : "next";
    const snapshot = inspect();
    const blocker = snapshot.blockers.find((entry) => entry !== INVISIBLE_CAPTCHA);
    if (blocker) throw new Error(blocker);
    if (snapshot.fields.some((f) => (f.required && !f.value) || f.invalid || f.validationWarning))
      throw new Error("Some fields on this step are empty or not accepted. Finish them first.");
    const controls = stepControls(document, adapterFor(location.href).next || undefined)[kind];
    if (controls.length !== 1) throw new Error(`This page has ${controls.length || "no"} ${kind === "next" ? "Next" : "Submit"} button${controls.length === 1 ? "" : "s"} to press.`);
    cs.writing = true;
    try {
      expectOwnedActivation(controls[0], "click");
      pressStep(controls[0], kind, String(command.label || ""));
    } finally {
      cs.writing = false;
    }
    return { pressed: stepLabel(controls[0]) };
  }
  // Which command, and which check, failed: three Workday fills ended on
  // this with nothing to say why (report 83effc7c).
  if (!valid(command)) throw new Error(`Operation is paused or stale (${command.type}: ${invalidCommandReason(command) || "unknown"})`);
  if (command.type === "AUTHORIZE_MAIN")
    return {
      authorized: authorizeMainWorld(
        { applicationId: cs.applicationId, documentId, operation: cs.operation },
        command.token || "",
      ),
    };
  if (command.type === "CONFIG_FILL" && configEngineEnabled) {
    if (!command.profile?.confirmed)
      throw new Error("A confirmed profile is required.");
    const pass = `${cs.operation}:${command.profile.revision}:${command.fieldId || ""}:${(command.onlyKeys || []).join(",")}`;
    if (cs.configPass === pass) return { statuses: cs.configCautions, observation: inspect() };
    cs.configPass = pass;
    cs.configCautions = [];
    // A SuccessFactors application folds its sections (Profile Information,
    // Previous Employment, Education, Job-Specific Information) behind
    // their title bars, and nothing inside a folded one is on the page:
    // one employer's form was read as one Language field and nothing was filled
    //. Each is opened, as the applicant would
    // open it, before the pass reads the form.
    // Sections drawn once those above them open (Fabrikam's Language Skills
    // and Geographic Mobility) come folded after the first
    // round: the applicant had to open them. Rounds go on until none is
    // left folded, four at most.
    for (let round = 0, waitedLate = false; round < 4 && !cs.paused; round++) {
      let folded = [...document.querySelectorAll<HTMLButtonElement>('.rcmFormSection button.rcmFormSectionTopBar[aria-expanded="false"]')];
      // After opening some, a moment for those drawn late.
      if (!folded.length && round > 0 && !waitedLate) {
        waitedLate = true;
        await pause(1000);
        folded = [...document.querySelectorAll<HTMLButtonElement>('.rcmFormSection button.rcmFormSectionTopBar[aria-expanded="false"]')];
      }
      if (!folded.length) break;
      cs.writing = true;
      try {
        for (const bar of folded) if (bar.isConnected && bar.getAttribute("aria-expanded") === "false") fillClick(bar);
      } finally {
        cs.writing = false;
      }
      for (let waited = 0; waited < 2_000 && folded.some((bar) => bar.isConnected && bar.getAttribute("aria-expanded") === "false"); waited += 100)
        await pause(100);
      await pause(300);
    }
    inspect();
    const signal = AbortSignal.any([
      cs.configController.signal,
      // Long forms (iCIMS rows searched one dropdown at a time) need it.
      // Workday's My Experience searches its field of study and each
      // skill in turn, about 20 s for a search that finds nothing: at 60 s
      // the pass ended before Skills. SuccessFactors
      // waits out each of a place's wordings its list lacks, 5 s apiece:
      // with three jobs and two schools the pass ended a minute in, with
      // "Master" typed into Highest Degree Achieved and never picked.
      // (configPassTimeout: SmartRecruiters' real-key picks too.)
      AbortSignal.timeout(configPassTimeout(location.hostname)),
    ]);
    const locked = (element: Element) => {
      if (!valid(command)) return true;
      if (
        element.ownerDocument !== document ||
        !element.isConnected
      )
        return true;
      const candidates = controlsWithin(element);
      if (
        candidates.some((candidate) =>
          radioGroup(candidate).some(
            (member) => !nodeRecords.has(member as HTMLElement),
          ),
        )
      )
        trackLocalControls(candidates);
      if (!valid(command)) return true;
      const nodes = new Set(
        candidates.flatMap((candidate) => {
          const group = radioGroup(candidate);
          const writableMembers = group.filter(writable);
          return group.length > 1 && writableMembers.length
            ? [candidate, ...writableMembers]
            : group;
        }),
      );
      return [...nodes].some((node) => {
        const record = nodeRecords.get(node as HTMLElement);
        return (
          Boolean(
            record &&
            (record.protected || hasEditLock(record.element, record.label)),
          ) ||
          (node as HTMLInputElement).disabled ||
          // A read-only box with its own picker button is filled from that
          // picker, as Tesla's start date is: the site
          // writes it, never this.
          // Nor is TikTok's UD select box, read-only until its list is
          // opened: it is chosen from.
          ((node as HTMLInputElement).readOnly && !pickerBox(node) &&
            !(node as Element).matches?.("input.ud__select__selector__search__input")) ||
          node.getAttribute("aria-disabled") === "true" ||
          node.getAttribute("aria-readonly") === "true"
        );
      });
    };
    const reconcileAutomation = (...elements: (Element | undefined)[]) => {
      const touched = new Set<RecordEntry>();
      for (const element of elements) {
        if (!element) continue;
        for (const control of controlsWithin(element))
          for (const member of radioGroup(control)) {
            const record = nodeRecords.get(member as HTMLElement);
            if (record) touched.add(record);
          }
      }
      for (const record of touched) {
        if (record.protected || !record.element.isConnected) continue;
        const value = valueOf(record.element);
        if (value !== record.last) {
          record.last = value;
          record.revision++;
          record.automationWritten = true;
        }
      }
    };
    // Widgets that keep their own state ignore assigned values and synthetic
    // keys alike; Workday's date sections are the reason this path exists.
    // CDP types into whatever the page has focused, so focus must be ours and
    // the page must not have the applicant's attention (see userAttention).
    const trustedType = (element: Element, text: string, safe: () => boolean, signal: AbortSignal, retry = true, enter = false, choose = false) =>
      typeTrusted(command, element, text, safe, signal, retry, enter, choose);
    // A signing date has one right answer: today. One the site or an earlier
    // fill left behind (a reloaded page keeps it) is retyped, Month first;
    // a date the applicant entered or locked is left alone.
    const now = new Date();
    const today = [
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      String(now.getFullYear()),
    ];
    for (const wrapper of document.querySelectorAll(
      '[data-automation-id="formField-todaysDate"],[data-automation-id="formField-dateSignedOn"],[data-automation-id="formField-currentDate"]',
    )) {
      const sections = ["Month", "Day", "Year"].map((name) =>
        wrapper.querySelector<HTMLInputElement>(`input[role="spinbutton"][aria-label="${name}"]`),
      );
      if (sections.some((section) => !section)) continue;
      // Only where the applicant lets a fill sign (signatures.ts).
      const signs = signatureField(sections[0]!);
      if (!signs || !signingAllowed(command.profile?.signatures, signs)) continue;
      const values = sections.map((section) => section!.value);
      if (values.every((value) => !value)) continue;
      if (values.every((value, i) => Number(value) === Number(today[i]))) continue;
      const records = sections.map((section) => nodeRecords.get(section!));
      if (
        records.some(
          (record) =>
            !record ||
            hasEditLock(record.element, record.label) ||
            (record.protected && record.protectedBy !== "existing value"),
        )
      )
        continue;
      for (const [i, section] of sections.entries()) {
        const record = records[i]!;
        record.protected = false;
        record.protectedBy = undefined;
        cs.writing = true;
        try {
          await trustedType(section!, today[i], () => valid(command) && !locked(section!), signal);
        } finally {
          cs.writing = false;
        }
        reconcileAutomation(section!);
      }
    }
    const result = await fillDocument(command.profile, {
      signal,
      onlyKeys: command.onlyKeys,
      // Without documents yet, an upload step would only open its dialog.
      skipKeys: command.uploads ? undefined : ["resume", "coverLetter"],
      onField: (element, key) => {
        // A rule may name a wrapper; the question is its one control's.
        const control = element.matches("input,textarea,select,button,[role]")
          ? element
          : element.querySelector('input:not([type="hidden"]),textarea,select,button[aria-haspopup="listbox"],[role="combobox"]');
        const label = control ? fieldLabel(control as Control) : "";
        tell({ type: "FILL_PROGRESS", applicationId: cs.applicationId, operation: cs.operation, documentId, label: label && label !== "Unlabelled field" ? label : key.replace(/_/g, " ") });
        cs.stopRecording?.note({ config: key, label: label.slice(0, 80) });
      },
      isLocked: locked,
      note: (data) => cs.stopRecording?.note(data),
      isReplaceable: (element) => {
        // A value that changed since the page was last read is read now:
        // the site may have answered the write just made (see above).
        const record = nodeRecords.get(element as HTMLElement);
        if (record && record.last !== valueOf(record.element)) inspect();
        // A value the site itself calls invalid is no answer to keep:
        // Microsoft's form showed an address assigned earlier that its own
        // state never took, flagged it, and it was never typed again.
        if (element.getAttribute("aria-invalid") === "true" && !hasEditLock(element as Control, record?.label || "")) return true;
        return Boolean(nodeRecords.get(element as HTMLElement)?.siteValue);
      },
      onConfirmed: (element) => {
        const record = nodeRecords.get(element as HTMLElement);
        if (record) record.confirmed = true;
      },
      // The site's own list of answers, read from this page's origin.
      listOptions: (source, terms) => fetchSiteOptions(source, location.href, terms, signal),
      async reactSelect(element, choose, searches) {
        const input = reactSelectInput(element);
        if (!input) return "unsupported";
        const safe = () =>
          valid(command) && !locked(input) && !locked(element);
        if (!safe()) return "skipped";
        // An existing selection is the user's or the site's; keep it,
        // unless the site parsed it from a resume.
        if (
          valueOf(input as Control) &&
          !nodeRecords.get(input as HTMLElement)?.siteValue
        )
          return "skipped";
        markEngineWrite(input, element);
        cs.writing = true;
        try {
          return await reactSelect(input, choose, searches, safe, signal);
        } finally {
          cs.writing = false;
          reconcileAutomation(input, element);
        }
      },
      async execute({ action, element, guardElement, method, values, entrySave }) {
        cs.stopRecording?.note({ config: method, id: element.id || undefined, text: (element.textContent || "").trim().slice(0, 40) || undefined, values: values.slice(0, 3).map((value) => value.slice(0, 40)) });
        // A guard the step itself removed ("Remove Resume" before the
        // upload slot it reveals) guards nothing (see runAction).
        const guardGone = () =>
          Boolean(guardElement && guardElement !== element && !guardElement.isConnected && element.isConnected);
        // A click on the page around the field: see clicksAround.
        const around = clicksAround(element, guardElement, method, action?.event);
        const safe = () =>
          valid(command) &&
          (around ? element.isConnected : !locked(element)) &&
          (!guardElement || guardGone() || !locked(guardElement));
        if (!safe()) {
          // Why a write was refused, for the recording: a refusal otherwise
          // leaves only the write note, as a school's "Did You Graduate?" did on
          // an iCIMS form.
          const record = nodeRecords.get(element as HTMLElement);
          cs.stopRecording?.note({ refused: element.id || method, reason: !valid(command) ? "stale command" : record?.protected ? `protected: ${record.protectedBy || ""}` : record && hasEditLock(record.element, record.label) ? lockReason(record.element, record.label) : "locked" });
          return false;
        }
        expectOwnedActivation(element, method, action?.event);
        markEngineWrite(element, guardElement);
        const savesBefore = cs.savesFinished;
        cs.writing = true;
        try {
          // A month picked from its calendar, in this page's own DOM.
          if (method === "pickMonth") {
            const picked = element instanceof HTMLInputElement && (await pickMonth(element, values[0] ?? ""));
            reconcileAutomation(element, guardElement);
            return picked;
          }
          if (method === "trustedType" || method === "trustedSearch" || method === "trustedChoose") {
            const typed = await trustedType(
              element,
              values[0] ?? "",
              safe,
              signal,
              true,
              method === "trustedSearch",
              // Oracle's lists (cx-select) load results only while the box
              // keeps focus and close when it blurs: typed for a pick, not
              // committed (Higher's School).
              method === "trustedChoose" || element.matches("input.cx-select-input"),
            );
            // The entry the menu lists for it: the site's own one where it
            // has it (SmartRecruiters' "Michigan State University" under its
            // "fill manually" one), else Down and Enter on the first, the
            // text as typed.
            if (typed && method === "trustedChoose") {
              // The site's own entry where it lists one, else the first
              // (the text as typed): Down to it, then Enter.
              const position = await listedPosition(element, values, signal);
              // A moment of the applicant's on the page (a click to watch
              // it) is waited out, as before typing: a pick skipped for it
              // left the typed city unchosen, and the box dropped it
              // (one employer's SmartRecruiters City).
              for (let waited = 0; safe() && userAttention() && !cs.applicantControl?.isConnected && waited < attentionSpan + 500 && !signal.aborted; waited += 150)
                await pause(150);
              // A box the site holds for a moment while it loads its
              // suggestions reads as locked: one employer's City was typed, then
              // refused "locked before the pick" 380 ms later and dropped
              //. Two seconds are waited out;
              // an edit lock of the applicant's stays one after them.
              for (let waited = 0; !safe() && valid(command) && !userAttention() && waited < 2000 && !signal.aborted; waited += 100)
                await pause(100);
              // Why nothing was picked, for the recording: that City's
              // trace showed only the typing and the Escape after it.
              if (!safe() || userAttention())
                cs.stopRecording?.note({ refused: element.id || method, reason: !valid(command) ? "stale command" : userAttention() ? "the applicant's attention" : `locked before the pick (${(() => {
                    // Which hold it was: Tailspin's City was refused here with
                    // none of them showing on the box afterwards.
                    const record = nodeRecords.get(element as HTMLElement);
                    const input = element as HTMLInputElement;
                    return [
                      record?.protected ? "protected" : "",
                      record && hasEditLock(record.element, record.label) ? "edit lock" : "",
                      input.disabled ? "disabled" : "",
                      input.readOnly ? "readonly" : "",
                      element.getAttribute("aria-disabled") === "true" ? "aria-disabled" : "",
                      element.getAttribute("aria-readonly") === "true" ? "aria-readonly" : "",
                      !element.isConnected ? "detached" : "",
                    ].filter(Boolean).join(", ") || "another control of the component";
                  })()})` });
              if (safe() && !userAttention()) {
                // Down moves focus into the menu, so the Enter lands on its
                // entry, not the box: the whole component is the write's,
                // or that Enter was held back as a stray key and nothing
                // was chosen (SmartRecruiters' Office location).
                let component: Element = element;
                for (let host = (element.getRootNode() as ShadowRoot).host as Element | undefined, depth = 0; host && depth < 4; host = (host.getRootNode() as ShadowRoot).host as Element | undefined, depth++) {
                  component = host;
                  if (host.matches("spl-autocomplete,[role='combobox']")) break;
                }
                cs.trustedWrite = component;
                try {
                  // One Down at a time until focus is on the wanted entry,
                  // then Enter there. A Down the menu let pass left focus in
                  // the box, and the Enter after it cleared what was typed:
                  // every Title, Company and School of a fill went empty
                  //. No Enter reaches the box.
                  const allowed = () => safe() && !userAttention();
                  const guard = { applicationId: cs.applicationId, operation: cs.operation, documentId };
                  const target = (position || 1) - 1;
                  // The entry a key reached: focused, or lit by the menu
                  // (its "active" mark; focus inside nested shadow roots
                  // did not read as the entry's on the site). Only after a
                  // key: the entry lit as the menu opens has no focus, and
                  // an Enter then lands in the box.
                  const reached = () => menuEntries(element).findIndex((entry) =>
                    (entry.getRootNode() as Document | ShadowRoot).activeElement === entry || entry.classList.contains("active") ||
                    entry.matches(":focus-within"));
                  let moved = false;
                  for (let tries = 0; tries < target + 4 && !(moved && reached() === target) && allowed(); tries++) {
                    // A menu that let one Down pass lets them all: the click
                    // below, at once, rather than seconds of keys.
                    if (moved && reached() < 0) break;
                    await requestTrustedType(element, guard, "", 0, signal, allowed, false, moved && reached() > target ? -1 : 1, true);
                    moved = true;
                    await pause(150);
                  }
                  if (moved && reached() === target && allowed())
                    await requestTrustedType(element, guard, "", 0, signal, allowed, true, 0);
                  // Every Down let pass (one employer's Company):
                  // a real click on the entry, as the applicant would.
                  else if (allowed() && window === window.top) {
                    const entry = menuEntries(element)[target];
                    if (entry) {
                      entry.scrollIntoView({ block: "nearest" });
                      await pause(100);
                      // The click lands on whatever is drawn at that point:
                      // a menu opened above its box sat under the page's
                      // sticky job header, and the click went to the header,
                      // not the school (one employer's SmartRecruiters
                      // Institution). Covered, the box is brought
                      // to the middle of the window so its menu has room,
                      // and a menu still covered is not clicked at all.
                      let point = entryPoint(entry);
                      if (!point && allowed()) {
                        (element as HTMLElement).scrollIntoView({ block: "center" });
                        await pause(300);
                        point = entryPoint(entry);
                      }
                      // A cover that passes is waited out while the menu
                      // still lists the entry: the toast the site shows on
                      // saving the entry before ("Experience saved") lay over
                      // the Institution's menu for three seconds, the pick
                      // was refused, and the school's Save failed for it
                      // (one employer's SmartRecruiters form).
                      for (let waited = 0; !point && waited < 6_000 && entry.isConnected && allowed() && !signal.aborted; waited += 250) {
                        await pause(250);
                        point = entryPoint(entry);
                      }
                      // A click that found another box at its point was
                      // kept from the page (see ownClickAt), and is made
                      // again once the entry is drawn there.
                      let clicked = false;
                      for (let attempt = 0; point && attempt < 3; attempt++) {
                        // Where entryPoint takes a hit as the entry's: in it, or in the
                        // option component drawing it.
                        const click = (cs.ownClickAt = { ...point, target: (entry.getRootNode() as ShadowRoot).host || entry, until: Infinity, missed: false });
                        clicked = true;
                        try {
                          await requestTrustedType(element, guard, "", 0, signal, allowed, false, 0, false, point);
                        } finally {
                          click.until = performance.now() + 400;
                        }
                        await pause(150);
                        if (!click.missed || !entry.isConnected || !allowed()) break;
                        cs.stopRecording?.note({ refused: element.id || method, reason: "the click on its menu entry reached another control; tried again" });
                        point = undefined;
                        for (let waited = 0; !point && waited < 3_000 && entry.isConnected && allowed() && !signal.aborted; waited += 250) {
                          await pause(250);
                          point = entryPoint(entry);
                        }
                      }
                      if (!clicked) {
                        // What lies over it, for the next capture (Tailspin's City).
                        const box = entry.getBoundingClientRect();
                        const over = document.elementFromPoint(Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2));
                        const named = over ? `${over.tagName.toLowerCase()}${over.id ? `#${over.id}` : ""}${typeof over.className === "string" && over.className ? `.${over.className.split(/\s+/)[0]}` : ""}` : "nothing";
                        cs.stopRecording?.note({ refused: element.id || method, reason: `its menu entry is covered by ${named} (entry at ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}, window ${innerWidth}x${innerHeight})` });
                      }
                    }
                  }
                } catch (error) {
                  /* Left as typed: the check after says so. */
                  cs.stopRecording?.note({ refused: element.id || method, reason: `pick: ${(error as Error)?.message || error}`.slice(0, 200) });
                } finally {
                  cs.trustedWrite = undefined;
                }
                cs.searchSettle = { element, until: performance.now() + 4000 };
              }
              reconcileAutomation(element, guardElement);
              return true;
            }
            reconcileAutomation(element, guardElement);
            if (typed) return true;
            // Real keystrokes were refused (this tab has the user's
            // attention, or the debugger is unavailable). Assigning the
            // value is what the engine did before; some widgets accept it.
            // A Workday date section does not: given "11" as a value it kept
            // no Month and set its Year to 2011 (one employer's signing date). It is left for a fill that can type.
            if (element.matches('input[role="spinbutton"][data-automation-id^="dateSection"],input[role="spinbutton"][id*="dateSection"]')) return false;
          }
          // Saving one entry of the section being filled (see entrySave in
          // the interpreter). Its button can be a submit button of the whole
          // application form, so it is clicked only with every submission
          // stopped before any page code sees it: the page's click handler
          // saves the entry, and no form is submitted.
          if (entrySave && element instanceof HTMLButtonElement && ["click", "reactClick"].includes(method)) {
            const block = (event: Event) => {
              event.preventDefault();
              event.stopImmediatePropagation();
            };
            window.addEventListener("submit", block, true);
            try {
              expectOwnedActivation(element, "click");
              fillClick(element);
            } finally {
              window.removeEventListener("submit", block, true);
            }
            await awaitSiteSave(savesBefore);
            return true;
          }
          // A configured option box is clicked, never assigned: see
          // checkControl.
          if (
            ["checkOption", "default", "defaultWithoutBlur"].includes(method) &&
            element instanceof HTMLInputElement &&
            ["checkbox", "radio"].includes(element.type)
          ) {
            // As the page-world writer reads a value for a box (Oracle's
            // "Current Job" gets "Yes").
            const wanted =
              method === "checkOption" ||
              element.type === "radio" ||
              !["", "false", "no", "0"].includes((values[0] ?? "").toLowerCase());
            const checked = (await checkControl(element, wanted)) && element.checked === wanted;
            reconcileAutomation(element, guardElement);
            await awaitSiteSave(savesBefore);
            return checked;
          }
          // An upload step gets the document this pass was given, or fails.
          const file =
            method === "uploadResume"
              ? command.uploads?.resume
              : method === "uploadCoverLetter"
                ? command.uploads?.cover
                : method === "uploadFile"
                  ? command.artifact
                  : undefined;
          if (/^upload(Resume|CoverLetter|File)$/.test(method) && !file) return false;
          // Clearing a search box that kept focus ends in a blur of our own:
          // the browser then fires a real change and focusout, which are
          // not the applicant's edit (Workday's How Did You Hear About Us?).
          if (method === "clearValue" && element === (element.getRootNode() as Document | ShadowRoot).activeElement)
            cs.searchSettle = { element, until: performance.now() + 1500 };
          const result = await requestMainWorld(
            element,
            { applicationId: cs.applicationId, operation: cs.operation, documentId },
            {
              ...(file ? { file } : {}),
              method: method === "trustedType" ? "default" : method === "trustedSearch" || method === "trustedChoose" ? "keyType" : method,
              values,
              event: action?.event,
              eventOptions: action?.eventOptions,
            },
            signal,
            safe,
          );
          // Without real keys a search box still gets its Enter, synthetic:
          // most Workday tenants search on it.
          // Without real keys, its menu's first entry chosen with synthetic
          // Down and Enter once the menu has had time to come.
          if (method === "trustedChoose" && result.ok) {
            await pause(1_500);
            for (const key of [{ key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40 }, { key: "Enter", code: "Enter", keyCode: 13, which: 13 }])
              await requestMainWorld(element, { applicationId: cs.applicationId, operation: cs.operation, documentId }, { method: "event", values, event: "keydown", eventOptions: key }, signal, safe);
          }
          if (method === "trustedSearch" && result.ok)
            await requestMainWorld(
              element,
              { applicationId: cs.applicationId, operation: cs.operation, documentId },
              {
                method: "event",
                values,
                event: "keydown",
                eventOptions: { key: "Enter", code: "Enter", keyCode: 13, which: 13 },
              },
              signal,
              safe,
            );
          reconcileAutomation(element, guardElement);
          // Written with the profile's answer, even one equal to what the
          // site parsed (no change to see): checked, not the site's guess
          // (one employer's "Did You Graduate?").
          const written = nodeRecords.get(element as HTMLElement);
          if (written && result.ok) written.confirmed = true;
          await awaitSiteSave(savesBefore);
          return result.ok;
        } finally {
          cs.writing = false;
          cs.lastEngineWrite = performance.now();
        }
      },
    }, command.fieldId ? records.get(command.fieldId)?.element : undefined).then((result) => {
      cs.configCautions = (result.statuses as { key: string; status: string; caution?: string }[]).flatMap((status) =>
        status.status === "filled" && status.caution ? [{ key: status.key, status: "filled" as const, caution: status.caution }] : []);
      return result;
    }).catch((error) => {
      if (!valid(command)) throw error;
      return {
        statuses: [
          {
            key: "config",
            status: "failed",
            reason: (error as Error).message,
          },
        ],
      };
    });
    return { ...result, observation: inspect() };
  }
  // Reads, without choosing anything, the options of dropdowns that only
  // list them once opened (react-select). A reviewed AI suggestion has to
  // name one of a field's real options, and nothing can be suggested for a
  // list nobody has read.
  if (command.type === "OPTIONS") {
    // A read is allowed during a human pause; a stale page or operation is not.
    const current = () => !cs.composing && command.applicationId === cs.applicationId && command.operation === cs.operation && command.documentId === documentId;
    if (!current()) throw new Error("Stale operation.");
    const read: { id: string; options: string[] }[] = [];
    const guard = { applicationId: cs.applicationId, operation: cs.operation, documentId };
    // Workday's questions, all answered by the questionnaire the page loaded
    // (see workday-questionnaire.ts): read there, nothing is opened.
    let questionnaire: QuestionnaireAnswers | undefined;
    const questionnaires = async () =>
      (questionnaire ??= await loadQuestionnaires(
        questionnaireUrls(performance.getEntriesByType("resource").map((entry) => entry.name), location.origin),
      ).catch(() => new Map() as QuestionnaireAnswers));
    for (const id of (command.fieldIds || []).slice(0, 40)) {
      const record = records.get(id);
      // A Workday list button: its question's answers from the
      // questionnaire, else opened, read and closed with nothing chosen
      // (one employer's Phone Device Type, "Home" and "Home Cellular", was
      // answered blind and missed).
      if (record && listButton(record.element) && !record.protected && record.element.isConnected &&
          record.element.getAttribute("aria-expanded") !== "true" && document.activeElement !== record.element) {
        const button = record.element as HTMLButtonElement;
        const listed = button.name ? (await questionnaires()).get(button.name) : undefined;
        if (listed?.length) {
          read.push({ id, options: listed });
          continue;
        }
        cs.writing = true;
        try {
          fillClick(button);
          let options: string[] = [];
          let steady = 0;
          for (let attempt = 0; attempt < 40 && steady < 2 && current(); attempt++) {
            await pause(50);
            const listId = (button.getAttribute("aria-controls") || "").split(/\s+/)[0];
            const list = listId ? document.getElementById(listId) : null;
            const shown = [...(list?.querySelectorAll<HTMLElement>('[role="option"]') || [])]
              .filter((option) => option.getAttribute("aria-disabled") !== "true")
              .map((option) => (option.textContent || "").replace(/\s+/g, " ").trim())
              .filter((option) => option && !/^select one$/i.test(option));
            // Workday fills the list a moment after it opens.
            steady = shown.length && shown.length === options.length ? steady + 1 : 0;
            options = shown;
          }
          if (button.getAttribute("aria-expanded") === "true") {
            button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
            await pause(100);
          }
          if (button.getAttribute("aria-expanded") === "true") {
            fillClick(document.querySelector<HTMLElement>('[data-automation-id="mainContent"]') || document.body);
            await pause(100);
          }
          if (document.activeElement === button) button.blur();
          if (options.length) read.push({ id, options: options.slice(0, 300) });
        } finally {
          cs.writing = false;
        }
        continue;
      }
      // A SmartRecruiters list draws its options only once first opened:
      // Gender, Race and Veteran were never open before their answers were
      // planned, read as none, and Veteran went unanswered. Opened, read and closed with nothing chosen;
      // quick, so also before a fill's plan.
      const splHost = (element: Element) => {
        for (let host = (element.getRootNode() as ShadowRoot).host as Element | undefined, depth = 0; host && depth < 4; host = (host.getRootNode() as ShadowRoot).host as Element | undefined, depth++)
          if (host.matches("spl-autocomplete,spl-multiselect-autocomplete")) return host;
        return undefined;
      };
      if (record && record.element instanceof HTMLInputElement && record.element.getAttribute("role") === "combobox" &&
          splHost(record.element) && controlledList(record.element) && !record.protected && record.element.isConnected &&
          !valueOf(record.element) && record.element.getAttribute("aria-expanded") !== "true") {
        const input = record.element;
        let options = drawnOptions(input);
        if (!options.length) {
          cs.writing = true;
          try {
            input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true, button: 0, view: window }));
            fillClick(input);
            for (let waited = 0; waited < 1500 && !options.length && current(); waited += 100) {
              await pause(100);
              options = drawnOptions(input);
            }
            if (input.getAttribute("aria-expanded") === "true") pressOutside();
            input.blur();
            await pause(150);
          } finally {
            cs.writing = false;
          }
        }
        if (options.length) read.push({ id, options: options.slice(0, 300) });
        continue;
      }
      // Microsoft's careers form draws a list's options only once opened:
      // its sponsorship question, read with none, went unanswered
      //. Opened (a click on the box, else its arrow), read,
      // and closed with nothing chosen; quick, so also before a plan.
      if (record && record.element instanceof HTMLInputElement && record.element.matches('input[role="combobox"][class*="select-module_select-input"]') &&
          !record.protected && record.element.isConnected && !valueOf(record.element) && !picksOf(record.element) &&
          record.element.getAttribute("aria-expanded") !== "true" && document.activeElement !== record.element) {
        const input = record.element;
        const listed = () => {
          const list = controlledList(input);
          return [...(list?.querySelectorAll<HTMLElement>('[role="option"]') || [])]
            .filter((option) => option.getAttribute("aria-disabled") !== "true")
            .map((option) => (option.getAttribute("title") || option.textContent || "").replace(/\s+/g, " ").trim())
            .filter(Boolean);
        };
        let options = listed();
        if (!options.length) {
          cs.writing = true;
          try {
            fillClick(input);
            for (let waited = 0; waited < 300 && input.getAttribute("aria-expanded") !== "true"; waited += 50) await pause(50);
            if (input.getAttribute("aria-expanded") !== "true")
              fillClick(input.parentElement?.querySelector<HTMLButtonElement>('button[aria-hidden="true"][tabindex="-1"]'));
            for (let waited = 0; waited < 1500 && !options.length && current(); waited += 100) {
              await pause(100);
              options = listed();
            }
            if (input.getAttribute("aria-expanded") === "true") {
              input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
              await pause(100);
            }
            if (input.getAttribute("aria-expanded") === "true") pressOutside();
            // The site hands focus back to the box as its list closes, and a
            // focused field is the applicant's: the answer was then skipped
            // as "The field currently has focus".
            for (let waited = 0; waited < 600; waited += 50) {
              if (document.activeElement === input || input.matches(":focus")) input.blur();
              await pause(50);
            }
          } finally {
            cs.writing = false;
          }
        }
        if (options.length) read.push({ id, options: options.slice(0, 300) });
        continue;
      }
      // A SuccessFactors pick list: its options asked of the list's own
      // model, as the page asks for them when it opens, so nothing is
      // opened, also during a fill (see sfPicklistOptions in mainWorld.ts).
      // Where there is no model, it is opened below for the AI pass.
      if (record && record.element instanceof HTMLInputElement && record.element.classList.contains("rcmpaginatedselectinput") &&
          !record.protected && record.element.isConnected && !valueOf(record.element)) {
        const input = record.element;
        cs.writing = true;
        try {
          const listed = await requestMainWorld(input, guard, { method: "sfPicklistOptions", values: [] }, undefined,
            () => current() && input.isConnected && !record.protected).catch(() => undefined);
          const options = listed?.ok
            ? (JSON.parse(listed.value || "[]") as unknown[])
              .filter((option): option is string => typeof option === "string" && !/^no selection$/i.test(option.trim()))
            : [];
          if (options.length) {
            read.push({ id, options: options.slice(0, 300) });
            continue;
          }
        } finally {
          cs.writing = false;
        }
      }
      if (command.listButtonsOnly) continue;
      const arrow = record && ashbyToggle(record.element);
      if (record && arrow && !record.protected && record.element.isConnected && !valueOf(record.element) &&
          document.activeElement !== record.element && record.element.getAttribute("aria-expanded") !== "true") {
        // Opened and closed again from its own arrow; nothing is chosen.
        const input = record.element as HTMLInputElement;
        cs.writing = true;
        try {
          fillClick(arrow);
          let options: string[] = [];
          for (let attempt = 0; attempt < 20 && !options.length && current(); attempt++) {
            await pause(50);
            const listId = input.getAttribute("aria-controls");
            const list = listId && !/\s/.test(listId) ? (input.getRootNode() as Document | ShadowRoot).querySelector(`#${CSS.escape(listId)}`) : null;
            options = [...(list?.querySelectorAll<HTMLElement>('[role="option"]') || [])]
              .map((option) => (option.textContent || "").trim()).filter(Boolean).slice(0, 100);
          }
          if (input.getAttribute("aria-expanded") === "true" && !input.value) fillClick(arrow);
          // The arrow hands focus to the input, sometimes a moment later.
          for (let waited = 0; waited < 600; waited += 50) {
            await pause(50);
            if (document.activeElement === input && !input.value) input.blur();
          }
          if (options.length) read.push({ id, options });
        } finally {
          cs.writing = false;
        }
        continue;
      }
      // A SuccessFactors list draws its options only once opened, a page at
      // a time as it is scrolled; the AI pass saw Status and Education Type
      // with none. Opened, scrolled while it
      // grows, read, and closed with nothing chosen.
      if (record && record.element instanceof HTMLInputElement && record.element.classList.contains("rcmpaginatedselectinput") &&
          !record.protected && record.element.isConnected && !valueOf(record.element) && document.activeElement !== record.element) {
        const input = record.element;
        cs.writing = true;
        try {
          fillClick(input);
          let options: string[] = [];
          let steady = 0;
          for (let attempt = 0; attempt < 60 && steady < 3 && options.length < 300 && current(); attempt++) {
            await pause(200);
            const listId = (input.getAttribute("aria-owns") || input.getAttribute("aria-controls") || "").split(/\s+/)[0];
            const list = listId ? document.getElementById(listId) : document.querySelector("ul.sf-list-select");
            const shown = [...new Set([...(list?.querySelectorAll<HTMLElement>('li[role="option"]') || [])]
              .map((option) => (option.textContent || "").replace(/\s+/g, " ").trim())
              .filter((option) => option && !/^no selection$/i.test(option)))];
            steady = shown.length && shown.length === options.length ? steady + 1 : 0;
            options = shown;
            list?.querySelector(":scope > li:last-child")?.scrollIntoView({ block: "end" });
            for (let box: Element | null = list, up = 0; box && up < 5; box = box.parentElement, up++) {
              if (box.scrollHeight > box.clientHeight + 4) box.scrollTop = box.scrollHeight;
              box.dispatchEvent(new Event("scroll"));
            }
          }
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          pressOutside();
          await pause(150);
          if (document.activeElement === input) input.blur();
          if (options.length) read.push({ id, options: options.slice(0, 300) });
        } finally {
          cs.writing = false;
        }
        continue;
      }
      if (record && ripplingSelect(record.element) && !record.protected && record.element.isConnected && !valueOf(record.element) &&
          document.activeElement !== record.element && record.element.getAttribute("aria-expanded") !== "true") {
        const control = record.element;
        cs.writing = true;
        try {
          fillClick(control);
          let options: string[] = [];
          for (let attempt = 0; attempt < 20 && !options.length && current(); attempt++) {
            await pause(50);
            const listId = control.getAttribute("aria-controls");
            const list = listId && !/\s/.test(listId) ? (control.getRootNode() as Document | ShadowRoot).querySelector(`#${CSS.escape(listId)}`) : null;
            if (list?.getAttribute("aria-busy") === "true") continue;
            options = [...(list?.querySelectorAll<HTMLElement>('[role="option"]') || [])]
              .filter((option) => option.getAttribute("aria-disabled") !== "true")
              .map((option) => (option.textContent || "").trim()).filter(Boolean).slice(0, 100);
          }
          if (control.getAttribute("aria-expanded") === "true") pressOutside();
          // Closed and unfocused before the next list is opened.
          await pause(120);
          if (document.activeElement === control) (control as HTMLElement).blur();
          if (options.length) read.push({ id, options });
        } finally {
          cs.writing = false;
        }
        continue;
      }
      const element = record && reactSelectInput(record.element);
      if (!record || !element || record.protected || !record.element.isConnected || valueOf(record.element)) continue;
      const safe = () => current() && element.isConnected && !record.protected && document.activeElement !== element;
      const call = (method: string) => requestMainWorld(element, guard, { method, values: [] }, undefined, safe);
      cs.writing = true;
      try {
        const listed = await call("reactSelectOptions");
        // Choosing nothing closes the menu and clears any search state.
        await call("reactSelectChoose").catch(() => undefined);
        if (listed.ok) {
          const options = (JSON.parse(listed.value || "[]") as string[]).filter((option) => typeof option === "string" && option.trim()).slice(0, 100);
          if (options.length) read.push({ id, options });
        }
      } catch {
        /* Unreadable lists stay without options. */
      } finally {
        cs.writing = false;
      }
    }
    return read;
  }
  if (command.type === "APPLY") return apply(command);
  if (command.type === "ATTACH") {
    // A document the site held before this extension (Amazon's stored
    // resume), when the applicant asked for it to be replaced. One they
    // chose themselves stays theirs.
    const held = records.get(command.fieldId!);
    if (command.replaceExisting && held?.protected && held.protectedBy === "existing value") {
      held.protected = false;
      held.protectedBy = undefined;
      held.siteValue = true;
    }
    // Focus an upload of ours left on a configured slot is no applicant's:
    // the résumé's upload in Workday's shared uploader ends on its "Select
    // files" button, which is the cover letter's slot, and the cover letter
    // was refused as a field in use.
    const slot = records.get(command.fieldId!);
    if (slot && cs.fileControls.has(slot.element) && document.activeElement === slot.element &&
        performance.now() - cs.lastApplicantInput > 2000)
      (slot.element as HTMLElement).blur();
    const guarded = guardedRecord(command, {
      fieldId: command.fieldId!,
      revision: command.revision!,
      expectedValue: command.expectedValue!,
    });
    const record = guarded.record;
    if (record?.element instanceof HTMLInputElement && replacesForm(record.element)) cs.siteFillUntil = performance.now() + 60_000;
    const artifact = command.artifact;
    const configured = record && cs.fileControls.get(record.element);
    if (record && configured && artifact && artifact.applicationId === cs.applicationId && artifact.operation === cs.operation) {
      const result = await executeCommand({
        ...command,
        type: "CONFIG_FILL",
        uploads: { [artifact.kind]: artifact },
      }) as { statuses?: { status: string }[] };
      const filled = result.statuses?.some((status) => status.status === "filled");
      // SmartRecruiters' spl-dropzone lists the file only once its own
      // upload is done, a few seconds on.
      const holds = () => valueOf(record.element) === artifact.name || currentFileName(record.element).split(", ").includes(artifact.name);
      if (filled && (record.element.getRootNode() as ShadowRoot).host?.localName === "spl-dropzone")
        for (let waited = 0; !holds() && waited < 8_000; waited += 250) await pause(250);
      const attached = filled && holds();
      if (attached) record.attachmentId = artifact.id;
      return { attached: Boolean(attached), observation: inspect() };
    }
    if (
      !record ||
      !(record.element instanceof HTMLInputElement) ||
      record.element.type !== "file" ||
      !artifact ||
      artifact.applicationId !== cs.applicationId ||
      artifact.operation !== cs.operation
    )
      throw new Error(`Stale or mismatched document attachment${guarded.reason ? ` (${guarded.reason})` : ""}.`);
    // Paylocity exposes a separate "Apply with resume" shortcut and a
    // parsing checkbox beside the ordinary uploader. Use the ordinary
    // upload without letting the parser discard fields already filled.
    if (record.element.id === "btn-resume" && /(^|\.)paylocity\.com$/i.test(location.hostname)) {
      const parser = document.getElementById("useAttachedResumeToFillOutApplication");
      if (parser instanceof HTMLInputElement && parser.checked) {
        const parserRecord = nodeRecords.get(parser);
        if (!valid(command) || hasEditLock(parser, fieldLabel(parser)) || (parserRecord?.protected && parserRecord.protectedBy !== "existing value"))
          throw new Error("Resume parsing is locked. Upload the resume manually.");
        markEngineWrite(parser);
        cs.writing = true;
        try { await checkControl(parser, false); } finally { cs.writing = false; }
        if (parser.checked || !valid(command)) throw new Error("Turn off resume parsing before uploading manually.");
        if (parserRecord) {
          parserRecord.last = valueOf(parser);
          parserRecord.revision++;
          parserRecord.automationWritten = true;
          parserRecord.protected = false;
          parserRecord.protectedBy = undefined;
        }
      }
    }
    const raw = atob(artifact.data);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const file = new File([bytes], artifact.name, { type: artifact.mime });
    const accept = record.element.accept.toLowerCase();
    if (
      accept &&
      !accept
        .split(",")
        .some(
          (a) =>
            a.trim() === `.${artifact.format}` ||
            a.trim() === artifact.mime ||
            a.trim() === "*/*" ||
            a.trim() === "application/*",
        )
    )
      throw new Error("Site does not accept this document format.");
    if (
      !guard(command, {
        fieldId: command.fieldId!,
        revision: command.revision!,
        expectedValue: command.expectedValue!,
      })
    )
      throw new Error("Attachment was superseded.");
    const errorBefore = uploadError(record.element);
    // Where the site shows an accepted file: some (Greenhouse's job boards)
    // empty or replace the input and show the file's name beside it.
    const uploadGroup = record.element.closest(
      '[role="group"], .file-upload, .field-wrapper, .application-question, fieldset, .field',
    );
    const transfer = new DataTransfer();
    transfer.items.add(file);
    cs.writing = true;
    try {
      record.writePendingAt = performance.now();
      if (configEngineEnabled) {
        const result = await requestMainWorld(
          record.element,
          { applicationId: cs.applicationId, operation: cs.operation, documentId },
          {
            method:
              artifact.kind === "resume"
                ? "uploadResume"
                : "uploadCoverLetter",
            values: [],
            file: artifact,
          },
          cs.configController.signal,
          () =>
            Boolean(
              guard(command, {
                fieldId: command.fieldId!,
                revision: command.revision!,
                expectedValue: command.expectedValue!,
              }),
            ),
        );
        if (!result.ok)
          throw new Error(result.reason || "Attachment failed.");
        record.last = valueOf(record.element);
        record.revision++;
        record.automationWritten = true;
      } else {
        record.element.files = transfer.files;
        changed(record);
      }
      record.attachmentId = artifact.id;
    } finally {
      cs.writing = false;
    }
    // Some sites fail the upload in their own handler and say so beside the
    // field; the file input alone would still look attached.
    let siteError = "";
    for (let waited = 0; waited < 2000 && !siteError; waited += 250) {
      await pause(250);
      const shown = uploadError(record.element);
      if (shown !== errorBefore) siteError = shown;
    }
    const shownName = Boolean(uploadGroup?.isConnected && uploadGroup.textContent?.includes(artifact.name));
    // SmartRecruiters' spl-dropzone empties its input and lists the file
    // in its files attribute once its own upload is done, a few seconds
    // on: read as not attached, the resume was "Verify upload"
    // (one employer's SmartRecruiters form).
    const listed = () => currentFileName(record.element).split(", ").includes(artifact.name);
    let listedName = listed();
    const dropzone = (record.element.getRootNode() as ShadowRoot).host?.localName === "spl-dropzone";
    for (let waited = 0; dropzone && !listedName && !siteError && record.element.files?.[0]?.name !== artifact.name && waited < 8_000; waited += 250) {
      await pause(250);
      listedName = listed();
    }
    return {
      attached: (record.element.files?.[0]?.name === artifact.name || shownName || listedName) && !siteError,
      siteError,
      observation: inspect(),
    };
  }
  throw new Error("Unknown content operation.");
}
