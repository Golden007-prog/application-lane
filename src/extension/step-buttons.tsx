import { useState } from "react";
import type { Application, QueueState, StepCheck } from "../shared/model";

// The step's own Next and Submit on an application's card (Settings →
// Processing). Next presses the page's single Next button. Submit
// first shows what would be pressed and what is unfinished or filled by AI,
// and presses only the button shown, once confirmed.
export function StepButtons({
  app,
  settings,
  disabled,
  send,
  run,
  onState,
}: {
  app: Application;
  settings: QueueState["settings"];
  disabled: boolean;
  send: <T>(message: unknown) => Promise<T>;
  run: (work: () => Promise<unknown>, success?: string) => Promise<void>;
  onState: (state: QueueState) => void;
}) {
  const [review, setReview] = useState<StepCheck>();
  const nextOn = settings.nextButton !== "off";
  const submitOn = settings.submitButton === "on";
  if (!nextOn && !submitOn) return null;
  const submitBlocked = review && (!review.submit || review.unfinished.length > 0 || review.blockers.length > 0);
  return (
    <>
      {nextOn && (
        <button
          className="small"
          disabled={disabled}
          title="Press this page's Next or Continue button"
          onClick={() => void run(async () => onState(await send<QueueState>({ type: "PRESS_STEP", id: app.id, step: "next" })))}
        >
          Next step
        </button>
      )}
      {submitOn && !review && (
        <button
          className="small"
          disabled={disabled}
          title="Check this page before pressing its Submit button"
          onClick={() => void run(async () => setReview(await send<StepCheck>({ type: "STEP_CHECK", id: app.id })))}
        >
          Submit…
        </button>
      )}
      {review && (
        <section className="step-review" aria-label="Before you submit">
          <strong>{review.submit ? `This presses "${review.submit}" on ${app.company || "the page"}.` : review.submitProblem}</strong>
          {review.blockers.length > 0 && (
            <ul>{review.blockers.map((item) => <li key={item}>{item}</li>)}</ul>
          )}
          {review.unfinished.length > 0 && (
            <>
              <small>Unfinished on this step:</small>
              <ul>{review.unfinished.map((item) => <li key={item}>{item}</li>)}</ul>
            </>
          )}
          {review.aiFilled.length > 0 && (
            <>
              <small>Filled by AI, check before submitting:</small>
              <ul>{review.aiFilled.map((item) => <li key={item}>{item}</li>)}</ul>
            </>
          )}
          {review.notes.length > 0 && (
            <>
              <small>Notes from the fill:</small>
              <ul>{review.notes.map((item) => <li key={item}>{item}</li>)}</ul>
            </>
          )}
          <div className="actions">
            <button
              className="primary small"
              disabled={disabled || Boolean(submitBlocked)}
              onClick={() =>
                void run(async () => {
                  onState(await send<QueueState>({ type: "PRESS_STEP", id: app.id, step: "submit", label: review.submit }));
                  setReview(undefined);
                })
              }
            >
              Submit now
            </button>
            <button className="text-button" onClick={() => setReview(undefined)}>
              Cancel
            </button>
          </div>
        </section>
      )}
    </>
  );
}
