#!/bin/bash
# One-time setup for working on reports shared on GitHub in an isolated
# session. Make a Claude token first (it opens a browser to sign in), then
# run this from the checkout as yourself:
#
#   claude setup-token
#   sudo bash scripts/report-sandbox/setup.sh
#
# It asks for the token, without showing it. It creates the lane-reports
# system user, which cannot read your home folder (your profile, documents,
# applications, and your GitHub and Claude sign-ins), and its work area
# /srv/lane-reports:
#   checkout/   its own clone of the public repository, which only it writes
#   browsers/   a copy of the Playwright browsers this repository's tests use
#   home/       its home, with the Claude token
#   inbox/      reports you hand it (github-reports work writes them), which it only reads
#   outbox/     what it leaves for you to read: a verdict and a patch
# Claude Code is copied to /opt/lane-reports/claude, the session's command to
# /usr/local/bin/lane-reports-agent and its instructions to
# /usr/local/share/lane-reports/PROMPT.md, all root-owned so it cannot change
# them. One sudoers rule lets you run that command as lane-reports, and
# nothing else. It has no GitHub sign-in: pull requests are opened by
# github-reports work, as you, from the patch it leaves.
#
# Run it again to update Claude Code, the command, its instructions, the
# browsers or the token (press Enter at the prompt to keep the token).
set -euo pipefail
owner="${SUDO_USER:?Run this with sudo, as yourself.}"
owner_home="$(getent passwd "$owner" | cut -d: -f6)"
here="$(cd "$(dirname "$0")" && pwd)"
checkout="$(cd "$here/../.." && pwd)"
root=/srv/lane-reports
user=lane-reports

# What it needs, checked before anything changes.
command -v setfacl >/dev/null || { echo "setfacl is missing: sudo apt install acl, then run this again." >&2; exit 1; }
command -v node >/dev/null || { echo "node is missing for root: install Node.js system-wide, then run this again." >&2; exit 1; }
[[ -x "$(readlink -f "$owner_home/.local/bin/claude")" ]] || { echo "Claude Code is not in $owner_home/.local/bin/claude." >&2; exit 1; }
[[ -f "$checkout/node_modules/playwright-core/browsers.json" ]] || { echo "Run npm ci in $checkout first." >&2; exit 1; }

id "$user" >/dev/null 2>&1 || useradd --system --home-dir "$root/home" --no-create-home --shell /usr/sbin/nologin "$user"

install -d -o root -g root -m 0755 "$root"
install -d -o "$user" -g "$user" -m 0700 "$root/home" "$root/checkout"
# The inbox is yours; it may only read it.
install -d -o "$owner" -g "$owner" -m 0750 "$root/inbox"
setfacl -m u:"$user":rx "$root/inbox"
setfacl -d -m u:"$user":rx,u:"$owner":rwx "$root/inbox"
# The outbox is its; you may only read it.
install -d -o "$user" -g "$user" -m 0750 "$root/outbox"
setfacl -m u:"$owner":rx "$root/outbox"
setfacl -d -m u:"$owner":rx,u:"$user":rwx "$root/outbox"

# Its clone of the public repository, over HTTPS without a sign-in: it can
# fetch, never push.
remote="https://github.com/$(git -C "$checkout" remote get-url origin | sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##').git"
if [[ ! -d "$root/checkout/.git" ]]; then
  sudo -u "$user" env -i PATH=/usr/bin:/bin HOME="$root/home" git clone -q "$remote" "$root/checkout"
fi
sudo -u "$user" env -i PATH=/usr/bin:/bin HOME="$root/home" git -C "$root/checkout" remote set-url origin "$remote"
sudo -u "$user" env -i PATH=/usr/bin:/bin HOME="$root/home" git -C "$root/checkout" config user.name "lane-reports"
sudo -u "$user" env -i PATH=/usr/bin:/bin HOME="$root/home" git -C "$root/checkout" config user.email "lane-reports@localhost"

# The Playwright browsers this repository's tests use.
install -d -o root -g root -m 0755 "$root/browsers"
for build in $(node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(b.browsers.filter(x=>/^(chromium|chromium-headless-shell|ffmpeg)$/.test(x.name)).map(x=>x.name.replaceAll("-","_")+"-"+x.revision).join(" "))' "$checkout/node_modules/playwright-core/browsers.json"); do
  [[ -d "$root/browsers/$build" ]] || cp -a "$owner_home/.cache/ms-playwright/$build" "$root/browsers/$build"
done
chown -R root:root "$root/browsers"
chmod -R a+rX,go-w "$root/browsers"

# Claude Code, the version you run.
install -d -o root -g root -m 0755 /opt/lane-reports
install -o root -g root -m 0755 "$(readlink -f "$owner_home/.local/bin/claude")" /opt/lane-reports/claude.new
mv /opt/lane-reports/claude.new /opt/lane-reports/claude

# The token, from claude setup-token.
read -r -s -p "Claude token from 'claude setup-token' (Enter keeps the current one): " token
echo
if [[ -n "$token" ]]; then
  [[ "$token" =~ ^[A-Za-z0-9_.-]{20,}$ ]] || { echo "That does not look like a token." >&2; exit 1; }
  printf '%s' "$token" > "$root/home/.claude-token.new"
  chown "$user:$user" "$root/home/.claude-token.new"
  chmod 0600 "$root/home/.claude-token.new"
  mv "$root/home/.claude-token.new" "$root/home/.claude-token"
fi
[[ -s "$root/home/.claude-token" ]] || { echo "No token yet: run claude setup-token, then this again." >&2; exit 1; }

# The session's command and instructions, and the one thing you may run as it.
install -d -o root -g root -m 0755 /usr/local/share/lane-reports
install -o root -g root -m 0644 "$here/PROMPT.md" /usr/local/share/lane-reports/PROMPT.md
install -o root -g root -m 0755 "$here/lane-reports-agent" /usr/local/bin/lane-reports-agent
rule="$owner ALL=($user) NOPASSWD: /usr/local/bin/lane-reports-agent"
printf '%s\n' "$rule" > /etc/sudoers.d/lane-reports.tmp
chmod 0440 /etc/sudoers.d/lane-reports.tmp
visudo -cf /etc/sudoers.d/lane-reports.tmp >/dev/null
mv /etc/sudoers.d/lane-reports.tmp /etc/sudoers.d/lane-reports

# Its dependencies, installed once now (later runs reinstall them when the
# lock file changes).
sudo -u "$user" env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$root/home" bash -c "cd '$root/checkout' && npm ci --no-audit --no-fund --loglevel=error && sha256sum package-lock.json | cut -d' ' -f1 > node_modules/.lane-lock"

echo "The isolated session is ready. Try it: sudo -n -u $user /usr/local/bin/lane-reports-agent --check"
