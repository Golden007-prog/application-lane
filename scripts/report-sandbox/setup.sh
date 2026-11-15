#!/bin/bash
# One-time setup for working on reports shared on GitHub in an isolated
# session. Make a Claude token first (it opens a browser to sign in), then
# run this from the checkout as yourself:
#
#   claude setup-token
#   sudo bash scripts/report-sandbox/setup.sh
#
# It asks for the token, without showing it. Each report is worked on in a
# container, which lane-reports (a system user that cannot read your home
# folder) starts with rootless Podman. The container clones the public
# repository afresh every time, has its own process list, and its own
# network, from which this computer's localhost (your backend) cannot be
# reached. It installs Podman if it is missing, and keeps in /srv/lane-reports:
#   home/       lane-reports' home: its Claude token and Podman's images
#   run/        Podman's runtime folder
#   npm-cache/  packages downloaded for the container, checked against the lock file on use
#   inbox/      reports you hand it (github-reports work writes them), which it only reads
#   outbox/     what it leaves for you to read: a verdict and a patch
# Claude Code is copied to /opt/lane-reports/claude, and the session's
# command to /usr/local/bin/lane-reports-agent, with its instructions and the
# script run in the container in /usr/local/share/lane-reports, all
# root-owned so it cannot change them. One sudoers rule lets you run that
# command as lane-reports, and nothing else. It has no GitHub sign-in: pull
# requests are opened by github-reports work, as you, from the patch it leaves.
#
# On WSL it also mounts the Windows drives for you alone (/etc/wsl.conf),
# which takes effect after `wsl --shutdown` from Windows.
#
# Run it again to update Claude Code, the image (after a Playwright update),
# the command, its instructions or the token (press Enter at the prompt to
# keep the token).
set -euo pipefail
owner="${SUDO_USER:?Run this with sudo, as yourself.}"
owner_home="$(getent passwd "$owner" | cut -d: -f6)"
here="$(cd "$(dirname "$0")" && pwd)"
checkout="$(cd "$here/../.." && pwd)"
root=/srv/lane-reports
share=/usr/local/share/lane-reports
user=lane-reports
# Commands run as lane-reports start in the current folder, and it may not
# enter yours.
cd /

# What it needs, checked before anything changes.
command -v node >/dev/null || { echo "node is missing for root: install Node.js system-wide, then run this again." >&2; exit 1; }
[[ -x "$(readlink -f "$owner_home/.local/bin/claude")" ]] || { echo "Claude Code is not in $owner_home/.local/bin/claude." >&2; exit 1; }
[[ -f "$checkout/node_modules/@playwright/test/package.json" ]] || { echo "Run npm ci in $checkout first." >&2; exit 1; }
missing=()
command -v setfacl >/dev/null || missing+=(acl)
command -v podman >/dev/null || missing+=(podman)
command -v slirp4netns >/dev/null || missing+=(slirp4netns)
command -v newuidmap >/dev/null || missing+=(uidmap)
if ((${#missing[@]})); then
  echo "Installing ${missing[*]}…"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" >/dev/null
fi

# On WSL, every Linux user can open the Windows drives (/mnt/c), and through
# them start Windows programs, which run as your Windows account. Mounted
# with umask 077 they are yours alone; this takes effect after
# `wsl --shutdown` (from Windows), and changes nothing for you or Windows.
if grep -qi microsoft /proc/version 2>/dev/null; then
  conf=/etc/wsl.conf
  if ! grep -q '^\[automount\]' "$conf" 2>/dev/null; then
    printf '\n[automount]\n# Windows drives for your own user only (scripts/report-sandbox/setup.sh).\noptions = "umask=077,fmask=077"\n' >> "$conf"
    echo "Added [automount] umask=077 to $conf. Run 'wsl --shutdown' from Windows, reopen WSL, then run the check."
  elif ! grep -Eq '^\s*options\s*=.*umask=0?77' "$conf"; then
    echo "$conf has an [automount] section without umask=077. Add umask=077,fmask=077 to its options, run 'wsl --shutdown' from Windows, then run this again." >&2
    exit 1
  fi
fi

id "$user" >/dev/null 2>&1 || useradd --system --home-dir "$root/home" --no-create-home --shell /usr/sbin/nologin "$user"
# Rootless Podman maps the container's users onto a range of its own, after
# every range already given out.
if ! grep -q "^$user:" /etc/subuid || ! grep -q "^$user:" /etc/subgid; then
  start=$(awk -F: '{ end = $2 + $3; if (end > max) max = end } END { print (max > 165536 ? max : 165536) }' /etc/subuid /etc/subgid)
  usermod --add-subuids "$start-$((start + 65535))" --add-subgids "$start-$((start + 65535))" "$user"
fi

install -d -o root -g root -m 0755 "$root"
install -d -o "$user" -g "$user" -m 0700 "$root/home" "$root/run" "$root/npm-cache"
# The inbox is yours; it may only read it.
install -d -o "$owner" -g "$owner" -m 0750 "$root/inbox"
setfacl -m u:"$user":rx "$root/inbox"
setfacl -d -m u:"$user":rx,u:"$owner":rwx "$root/inbox"
# The outbox is its; you may only read it.
install -d -o "$user" -g "$user" -m 0750 "$root/outbox"
setfacl -m u:"$owner":rx "$root/outbox"
setfacl -d -m u:"$owner":rx,u:"$user":rwx "$root/outbox"
# The earlier setup's own clone and browsers: the container has its own.
rm -rf "$root/checkout" "$root/browsers"

as_user() { sudo -u "$user" env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$root/home" XDG_RUNTIME_DIR="$root/run" LANG=C.UTF-8 "$@"; }
# Podman without a login session: cgroups it manages itself, events to a file.
install -d -o "$user" -g "$user" -m 0700 "$root/home/.config" "$root/home/.config/containers"
printf '[engine]\ncgroup_manager = "cgroupfs"\nevents_logger = "file"\n' > "$root/home/.config/containers/containers.conf"
chown "$user:$user" "$root/home/.config/containers/containers.conf"
as_user podman system migrate >/dev/null 2>&1 || true

# The image: Playwright's own for the version this repository pins, with git.
playwright="$(node -p 'require(process.argv[1]).version' "$checkout/node_modules/@playwright/test/package.json")"
image="localhost/lane-reports:$playwright"
# Built from a copy where lane-reports can read it (it cannot read your checkout).
install -d -o root -g root -m 0755 "$share"
install -o root -g root -m 0644 "$here/Containerfile" "$share/Containerfile"
if ! as_user podman image exists "$image"; then
  echo "Building the session's image (Playwright $playwright); the first time downloads about 2 GB…"
  as_user podman build -q --build-arg PLAYWRIGHT="$playwright" -t "$image" -f "$share/Containerfile" "$share" >/dev/null
fi

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

# The session's command, its instructions, what runs in the container, and
# the one thing you may run as lane-reports.
remote="https://github.com/$(git -C "$checkout" remote get-url origin | sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##').git"
install -d -o root -g root -m 0755 "$share"
install -o root -g root -m 0644 "$here/PROMPT.md" "$share/PROMPT.md"
install -o root -g root -m 0644 "$here/inside.sh" "$share/inside.sh"
printf '%s\n' "$image" > "$share/image"
printf '%s\n' "$remote" > "$share/repository"
chmod 0644 "$share/image" "$share/repository"
install -o root -g root -m 0755 "$here/lane-reports-agent" /usr/local/bin/lane-reports-agent
rule="$owner ALL=($user) NOPASSWD: /usr/local/bin/lane-reports-agent"
printf '%s\n' "$rule" > /etc/sudoers.d/lane-reports.tmp
chmod 0440 /etc/sudoers.d/lane-reports.tmp
visudo -cf /etc/sudoers.d/lane-reports.tmp >/dev/null
mv /etc/sudoers.d/lane-reports.tmp /etc/sudoers.d/lane-reports

echo "The isolated session is ready. Check it: sudo -n -u $user /usr/local/bin/lane-reports-agent --check"
grep -qi microsoft /proc/version 2>/dev/null && ! grep -Eq "umask=0?77" /proc/mounts && echo "On WSL, run 'wsl --shutdown' from Windows first, so the Windows drives are mounted for you alone."
true
