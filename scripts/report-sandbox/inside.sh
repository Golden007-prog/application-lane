#!/bin/bash
# Runs inside the isolated session's container (lane-reports-agent starts
# it). Each run clones the repository afresh into the container's own
# filesystem, which goes when the container does: nothing an earlier session
# wrote (git settings, Claude Code settings, packages) is there.
#
#   inside.sh check <probe port> <host address…>   what it can reach, and that Claude answers
#   inside.sh work <issue number> <model>          the prompt on stdin; leaves /outbox/{fix.patch,agent.log,exit}
set -uo pipefail
mode="${1:-}"
repository="$(cat /lane/repository)"

if [[ "$mode" == check ]]; then
  fail() { echo "FAIL (inside): $*" >&2; exit 1; }
  port="$2"
  shift 2
  [[ "$(id -u)" != 0 ]] || fail "it runs as root in the container"
  [[ ! -e /mnt/c && ! -e /mnt/wslg ]] || fail "a Windows drive or WSL folder is mounted"
  [[ ! -e /srv/lane-reports ]] || fail "the work area is mounted"
  # Its own process list: the command that started it is outside, unseen.
  # (The pattern is written so that grep's own command line does not match it.)
  for cmdline in /proc/[0-9]*/cmdline; do tr '\0' ' ' <"$cmdline" 2>/dev/null; echo; done | grep -q 'lane-reports-agen[t]' && fail "it can see the computer's processes"
  # A service listening on the computer's own localhost (as the backend
  # does) is out of reach, however it is addressed.
  node -e '
    const net = require("net");
    const [port, ...hosts] = process.argv.slice(1);
    const tries = [...new Set(["10.0.2.2", "host.containers.internal", "host.docker.internal", ...hosts])].map((host) => new Promise((resolve) => {
      const socket = net.connect({ host, port: Number(port), timeout: 3000 });
      socket.on("connect", () => { socket.destroy(); resolve(host); });
      socket.on("error", () => resolve(""));
      socket.on("timeout", () => { socket.destroy(); resolve(""); });
    }));
    Promise.all(tries).then((reached) => { reached = reached.filter(Boolean); if (reached.length) { console.error(reached.join(", ")); process.exit(1); } });
  ' "$port" "$@" || fail "it can reach a service on the computer's localhost"
  git ls-remote -q "$repository" main >/dev/null || fail "it cannot fetch the repository"
  answer="$(printf 'Reply with the single word ready.' | timeout 120 claude -p --model sonnet 2>&1)"
  [[ "$answer" == *ready* ]] || fail "Claude Code did not answer: ${answer:0:200}"
  exit 0
fi

[[ "$mode" == work ]] || { echo "inside.sh: check or work" >&2; exit 2; }
model="$3"
prompt="$(cat)"
status=0
{
  git clone -q --depth 50 "$repository" /home/agent/work &&
    cd /home/agent/work &&
    npm ci --no-audit --no-fund --loglevel=error
} >/outbox/setup.log 2>&1 || { echo "clone or install failed" >>/outbox/setup.log; echo 90 >/outbox/exit; exit 0; }
printf '%s\n' "$prompt" | claude -p --model "$model" --dangerously-skip-permissions --add-dir /inbox --add-dir /outbox >/outbox/agent.log 2>&1 || status=$?
# The patch: what changed under src/ and tests/, new files included.
git add -A -N -- src tests
git diff --no-color --no-ext-diff --binary HEAD -- src tests >/outbox/fix.patch
echo "$status" >/outbox/exit
