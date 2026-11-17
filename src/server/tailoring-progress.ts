import type { GenerationJob, TailoringItem } from "../shared/model";

// What a generation job reports while it works: one item per document and
// per written question, each with the steps that item really passes through.
// A step is counted when it ends, never by the clock: an item with a step in
// progress has `done` of `total` steps behind it and no finer fraction.
export class TailoringProgress {
  private steps = new Map<string, string[]>();
  constructor(private job: GenerationJob) {
    job.progress = [];
  }
  add(id: string, name: string, kind: TailoringItem["kind"], steps: string[]) {
    this.steps.set(id, steps);
    this.job.progress!.push({ id, name: name.slice(0, 200), kind, state: "waiting", done: 0, total: steps.length, step: steps[0] });
  }
  has(id: string) {
    return this.steps.has(id);
  }
  private item(id: string) {
    return this.job.progress!.find((item) => item.id === id);
  }
  // The item's next step has started.
  begin(...ids: string[]) {
    for (const id of ids) {
      const item = this.item(id);
      if (item && item.state === "waiting") item.state = "running";
    }
  }
  // The item's current step has ended.
  finish(...ids: string[]) {
    for (const id of ids) {
      const item = this.item(id);
      if (!item || item.state === "done" || item.state === "failed") continue;
      item.done++;
      item.step = this.steps.get(id)![item.done];
      item.state = item.done >= item.total ? "done" : "waiting";
      if (item.state === "done") delete item.step;
    }
  }
  // Nothing left to do for the item (its documents were kept from before).
  complete(...ids: string[]) {
    for (const id of ids) {
      const item = this.item(id);
      if (!item || item.state === "failed") continue;
      item.done = item.total;
      item.state = "done";
      delete item.step;
    }
  }
  fail(id: string, error: string) {
    const item = this.item(id);
    if (!item || item.state === "done") return;
    item.state = "failed";
    item.error = error.slice(0, 300);
  }
  // The job itself ended on an error: what was not done did not happen.
  failUnfinished(error: string) {
    for (const item of this.job.progress!) if (item.state !== "done") this.fail(item.id, error);
  }
}
