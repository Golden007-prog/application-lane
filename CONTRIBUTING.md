# Contributing

Thanks for helping make Application Lane better. Bug reports, site fixes and documentation improvements are all welcome. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). For where to make a change, see the [code map](docs/code-map.md).

## Before you start

- For a bug, open an issue with the bug report template. **Never paste personal data**: no résumés, profile contents, `config.json`, tokens, API keys or real application answers.
- For a security problem, use a private advisory instead (see [SECURITY.md](SECURITY.md)).
- For a larger change, open an issue first so we can agree on the approach.

## Setup

You need Node.js 22 (`.nvmrc` says `22`; run `nvm use` if you use nvm) and a Chromium browser.

```bash
git clone https://github.com/<you>/application-lane.git
cd application-lane
npm ci
npm run build
```

Load `dist/extension` unpacked in `chrome://extensions` and start the backend with `npm start` (or `npm run dev` to restart on changes). To keep test data away from your real profile, set `LANE_DATA_DIR`, for example `LANE_DATA_DIR=/tmp/lane-dev npm start`.

See [docs/development.md](docs/development.md) for the project layout and more detail.

## Checks

Run these before opening a pull request:

```bash
npm run check                              # type check
npm run lint                               # lint: an empty catch says why
node --import tsx --test tests/*.test.ts   # unit tests
npm run build                              # extension and backend bundle
```

If you changed the extension, the form engine or site rules, run the related browser tests too:

```bash
npx playwright install chromium            # once
npx playwright test tests/browser/extension.spec.ts -g "<pattern>"
```

`npm run test:browser` runs the whole browser suite (it takes a while). The browser tests use synthetic applicants and local fixtures only; they never contact real job sites.

## Code style

- TypeScript throughout; keep `npm run check` clean.
- Format with Prettier (`npx prettier --write <files>`). Match the style of the surrounding code.
- Comments explain *why*, in plain sentences.
- Add or update a test with every behavior change. Site-rule changes need a fixture-based test.
- User-facing text is plain and friendly. The extension must never submit, click Next or overwrite a user's edit on its own (Next step and Submit press the page's button only on the user's request), and must never sign or tick a consent box the applicant's settings do not allow. Every click goes through `src/engine/page/click-gate.ts`; changes that weaken these guarantees will not be accepted.

## Never commit personal data

- No real résumés, profiles, transcripts, application answers, issue reports, recordings or network captures.
- Nothing from a data folder (`.local/`, `~/.local/share/application-lane`, and so on), and no tokens or API keys.
- Test fixtures must use invented applicants and placeholder employers or publicly available form structure only.
- Fill captures and issue reports stay on the machine that made them. A capture is the page as the fill left it, which is the applicant's own answers (name, contacts, address, work history, written answers, the companies applied to), and its network log adds cookies and everything the page posted. Cleaning a whole page reliably is much harder than cleaning a report, so a fix reaches the public tests as a fixture rebuilt from the page's structure (its markup, ids and question wording) with an invented applicant and a placeholder employer.

## Pull request checklist

- [ ] `npm run check` passes
- [ ] Unit tests pass (`node --import tsx --test tests/*.test.ts`)
- [ ] `npm run build` succeeds
- [ ] Related browser tests pass, if the extension or site rules changed
- [ ] Tests added or updated for the change
- [ ] Docs updated if behavior or setup changed
- [ ] No personal data, tokens or API keys in the diff
- [ ] A line in [CHANGELOG.md](CHANGELOG.md) under "Unreleased" for user-visible changes

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
