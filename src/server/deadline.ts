// A signal that aborts when the caller's does, or after `ms`, whichever is
// first. Instead of AbortSignal.any([signal, AbortSignal.timeout(ms)]): on
// Node 20 that combined signal holds its sources weakly, and a timeout
// collected as garbage before it fires never aborts it. Under load (the
// browser suite's three workers) a drafting call meant to give up after 2 s
// ran for a minute, until an outer limit stopped it. Here the timer holds the
// controller, so the limit lasts until it fires or is no longer needed.
export function withinTime(ms: number, signal?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
  // The backend may still exit while a limit is pending.
  timer.unref?.();
  const follow = () => controller.abort(signal!.reason);
  if (signal?.aborted) follow();
  else signal?.addEventListener("abort", follow, { once: true });
  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", follow);
    },
    { once: true },
  );
  return controller.signal;
}
