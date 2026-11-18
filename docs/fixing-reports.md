# Fixing shared reports

People share fill problems with **Share on GitHub** (dashboard → Issues), which opens a **Fill report** issue with a cleaned copy of their report attached. This page is for maintainers, of this repository or a fork: how to turn those issues into pull requests with Claude Code, without the reports touching anything private on your computer.

Anyone can open an issue, and a report can be written to steer an AI agent ("ignore your instructions and…"). So a report is never worked on by a session that holds your data or your GitHub sign-in. It goes to an **isolated session**: containers, started by a separate system user, with a fresh copy of the public repository and nothing else. One container fetches the repository and its packages, with no network of its own: git and npm in it reach GitHub and the npm registry through a second small proxy (`egress-proxy.mjs`), which passes on HTTPS to those two hosts at a public address and nothing else, so your computer and your network are out of its reach. Packages are downloaded afresh each run. The agent then works in a second one that has no network at all and no Claude token. Its requests to Claude go through a small proxy that the system user runs outside the container, which adds the token and passes on nothing but the Messages API. So a report written to steer the agent finds no token to read and nowhere to send anything. That session writes a patch; a plain script, not an agent, checks it and opens the pull request; and you review it before anything reaches `main`.

## What you need

- Linux, or Windows with WSL 2 (macOS is not supported for this part).
- The [GitHub CLI](https://cli.github.com/), signed in (`gh auth login`) with write access to the repository.
- [Claude Code](https://claude.com/claude-code) with a Claude subscription, for `claude setup-token`.
- A clone of the repository with `npm ci` run in it, and `sudo` on the machine.

## One-time setup

1. **Make a token for the isolated session.** It signs in with a long-lived token of its own, never with your Claude Code sign-in:
   ```bash
   claude setup-token
   ```
2. **Run the setup**, from the clone, and paste the token when it asks (it is not shown):
   ```bash
   sudo bash scripts/report-sandbox/setup.sh
   ```
   It installs Podman if needed, creates the `lane-reports` system user (it cannot read your home folder), builds the container image (about 2 GB the first time) from Playwright's image named by its digest, and has every session run that exact build by its ID, and adds one sudoers rule: you may start `/usr/local/bin/lane-reports-agent` as `lane-reports`, and nothing else. On WSL it also mounts the Windows drives for your own user only; run `wsl --shutdown` from Windows once afterwards.
3. **Check it:**
   ```bash
   sudo -n -u lane-reports /usr/local/bin/lane-reports-agent --check
   ```
   It should print `OK: …`. The check confirms that `lane-reports` cannot read your home or the Windows drives, and that inside the containers nothing of your files is mounted, your other processes are out of sight, and a service on your computer's `localhost` (such as the backend) cannot be reached. It also confirms that the fetch container reaches the internet only through the egress proxy, which refuses any other host, that the agent's container holds no token and cannot reach the internet, and that Claude Code answers in it through the token proxy. Do not work on reports while it prints `FAIL`.
4. **Labels.** The issue form adds `fill report`. Create that label, and an `accepted` label, in the repository:
   ```bash
   gh label create "fill report" && gh label create accepted
   ```

Run the setup again after a Claude Code or Playwright update, or to change the token (press Enter at the prompt to keep it).

## Working on a report

1. **Read the issue on GitHub.** If it looks genuine, add the `accepted` label. Only an issue with that label, added by a maintainer, is fetched; one edited after it was accepted waits until you take the label off and add it again, so the attached file cannot be swapped after you read it.
2. **Fetch it:**
   ```bash
   npm run github-reports -- sync
   ```
   The attached report is downloaded (from GitHub's own attachment addresses only), checked to be a report, and saved with its pages made inert: scripts, frames and event handlers renamed, so nothing in them can run.
3. **Work on it:**
   ```bash
   npm run github-reports -- work <issue number>        # add --model opus for a hard one
   ```
   This takes up to 50 minutes. The isolated session clones `main`, writes a test from the report's captured page, shows it fails, fixes the cause and leaves a patch with a verdict. The script then keeps the patch only if it changes ordinary files under `src/` and `tests/` (no workflows, hooks, scripts or dependencies, no binary files or links), applies it in a temporary worktree, commits it on a `github-report-<n>` branch and opens a **draft** pull request that closes the issue when merged. If the patch adds anything under `src/` that could send something somewhere (a new web address's host, a `fetch`, `XMLHttpRequest`, `WebSocket` or `sendBeacon`, `eval`, or a Chrome API such as cookies or history), the pull request lists it under "Check these additions closely". It prints only the verdict, the files changed and the pull request's address.
4. **Review the pull request** as you would any outside contribution, and merge it or close it. CI runs its checks on it; the full browser suite runs from the Actions tab.

Other verdicts are `cannot-reproduce` and `not-a-bug`: nothing is changed, and the session's reasons are in `/srv/lane-reports/outbox/<n>/summary.json` for you to read before replying.

## Commands

```text
npm run github-reports -- sync [--quiet]                fetch accepted fill-report issues and their reports
npm run github-reports -- list [--json]                 the issues seen, and where each stands
npm run github-reports -- work <n> [--model sonnet|opus] fix it in the isolated session, and open a pull request
npm run github-reports -- mark <n> <state> [--note "…"] record where an issue stands
npm run github-reports -- reply <n> "<text>" [--close]   comment on the issue
```

`reply`, and the title and description of a pull request, are refused if they name the details in your own data folder (the leak check's terms) or a path on your computer.

## In a fork

- Point the share flow and these commands at your repository: `REPORT_REPOSITORY_URL` in `src/shared/share.ts`.
- Who may accept an issue: the repository's owner by default, or the GitHub logins in `LANE_REPORT_MAINTAINERS` (comma-separated).

## What the isolation does not cover

- The container that fetches the repository and its packages can reach the internet. It runs no agent and holds no token.
- The agent can still make Claude requests through the proxy for as long as its session runs (at most 50 minutes), on your subscription's usage. The token itself never enters the container; `lane-reports` holds it, so only a way out of the container and into that user would reach it. What the proxy passed on or refused is in the outbox's `proxy.log`. What the egress proxy passed on or refused, by host, is in `egress.log`.
- A pull request from a report is code written from outside input. Read it before merging.
