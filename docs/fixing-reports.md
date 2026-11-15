# Fixing shared reports

People share fill problems with **Share on GitHub** (dashboard → Issues), which opens a **Fill report** issue with a cleaned copy of their report attached. This page is for maintainers, of this repository or a fork: how to turn those issues into pull requests with Claude Code, without the reports touching anything private on your computer.

Anyone can open an issue, and a report can be written to steer an AI agent ("ignore your instructions and…"). So a report is never worked on by a session that holds your data or your GitHub sign-in. It goes to an **isolated session**: a container, started by a separate system user, with a fresh copy of the public repository and nothing else. That session writes a patch; a plain script, not an agent, checks it and opens the pull request; and you review it before anything reaches `main`.

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
   It installs Podman if needed, creates the `lane-reports` system user (it cannot read your home folder), builds the container image (about 2 GB the first time) and adds one sudoers rule: you may start `/usr/local/bin/lane-reports-agent` as `lane-reports`, and nothing else. On WSL it also mounts the Windows drives for your own user only; run `wsl --shutdown` from Windows once afterwards.
3. **Check it:**
   ```bash
   sudo -n -u lane-reports /usr/local/bin/lane-reports-agent --check
   ```
   It should print `OK: …`. The check confirms that `lane-reports` cannot read your home or the Windows drives, and that inside the container nothing of your files is mounted, your other processes are out of sight, a service on your computer's `localhost` (such as the backend) cannot be reached, and Claude Code answers. Do not work on reports while it prints `FAIL`.
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
   This takes up to 50 minutes. The isolated session clones `main`, writes a test from the report's captured page, shows it fails, fixes the cause and leaves a patch with a verdict. The script then keeps the patch only if it changes ordinary files under `src/` and `tests/` (no workflows, hooks, scripts or dependencies, no binary files or links), applies it in a temporary worktree, commits it on a `github-report-<n>` branch and opens a pull request that closes the issue when merged. It prints only the verdict, the files changed and the pull request's address.
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

- The container can reach the internet (Claude Code needs to). Nothing private is in it to send, but it is not limited to Claude's servers.
- The isolated session holds its Claude token. If a session were turned against you, the token could be used until you revoke it; it gives no access to your files or your GitHub account.
- A pull request from a report is code written from outside input. Read it before merging.
