# Code map: where to make a change

A guide for a first change. For how the pieces talk to each other and what they promise, read [architecture and limits](architecture.md); for building and testing, [development](development.md).

## The pieces

```
side panel / dashboard (React)      src/extension/panel.tsx, src/extension/panel/*
        │  chrome.runtime messages
service worker                      src/extension/background.ts, src/extension/background/*
        │  tabs.sendMessage                 │  HTTP on 127.0.0.1:4318 (pairing token)
content script (each job page)      local backend (Node)
src/extension/content.ts            src/server/app.ts and the modules beside it
src/extension/content/*                     │
        │  uses                             │  calls, when drafting is set up
form engine + site rules            Claude Code / Codex CLI, or an HTTP model
src/engine/*, src/engine/config/*
```

`src/shared/` is used by all of them: the data model (`model.ts`), how fields are matched to profile values (`matching.ts`), question kinds (`questions.ts`), dates, geography, eligibility answers.

Imports go one way. `shared` imports no other layer. `engine` imports `shared` and nothing from `extension` or `server`. `extension` and `server` import `engine` and `shared`, never each other, and nothing under `src/` imports from `scripts/`. The site rules' JSON tables (`src/engine/config/*.json`) are data that any layer may read. `tests/layering.test.ts` checks these rules.

## Where to change what

| You want to… | Start in | Test with |
| --- | --- | --- |
| Fix a field on one site (wrong value, missed field, wrong option) | That site's rules, `src/engine/config/sites/<site>.json`, in the schema of `src/engine/config/schema.ts` | `tests/config-regressions.test.ts`, then a fixture test in `tests/browser/extension.spec.ts` |
| Support a new site | A new `src/engine/config/sites/<site>.json`, then `node scripts/site-catalog.mjs` to regenerate `src/engine/config/catalog.ts` | as above |
| Change how a label is read or a field is recognised on any site | `src/extension/semantics.ts`, `src/engine/page/labels.ts` | `tests/form-matching.test.ts`, browser fixtures |
| Change which profile value answers a question | `src/shared/matching.ts` (and `authorization.ts`, `standing.ts`, `education.ts` for those topics) | `tests/form-matching.test.ts`, `tests/eligibility.test.ts` |
| Change what is clicked, or when | `src/engine/page/click-gate.ts` (every click passes it), `src/engine/page/step-controls.ts` | `tests/click-gate.test.ts`, `tests/step-controls.test.ts` |
| Change filling itself (typing, choosing, waiting) | `src/extension/content/apply.ts`, `choose.ts`, `controls.ts`; one command each in `src/extension/content/commands/` | browser suite |
| Change the queue, tabs or badges | `src/extension/background/queue.ts`, `tabs.ts`, `badges.ts` | browser suite |
| Change a page of the side panel or dashboard | `src/extension/panel/<page>-page.tsx`; state and handlers in `usePanel()` in `src/extension/panel.tsx` | browser suite |
| Change résumé, letter or answer drafting | `src/server/generation.ts` (the queue and the letter), `src/server/answers.ts` (written answers), `src/server/cli-provider.ts` (Claude Code and Codex) | `tests/generation.test.ts`, `tests/answers.test.ts` |
| Change a backend route | `src/server/app.ts`; the extension calls it from `src/extension/background/` | `tests/core.test.ts`, `tests/route-contract.test.ts` |
| Change how a fill report is cleaned before sharing | `src/server/clean-report.ts`, `src/server/leak-terms.mjs` | `tests/clean-report.test.ts` |
| Change the command line or terminal view | `scripts/lane.ts` | `tests/lane-cli.test.ts` |

## Before you open a pull request

- `npm run check`, `npm run lint` and `npm test` pass.
- A change to filling has a fixture in `tests/browser/` made from a form's structure. Invented applicant, placeholder employer, never a real page saved with someone's answers on it.
- Nothing in [CONTRIBUTING.md](../CONTRIBUTING.md)'s "Never commit personal data" list is in your diff.
