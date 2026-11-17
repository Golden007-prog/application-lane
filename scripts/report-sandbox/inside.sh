#!/bin/bash
# Runs inside the isolated session's containers (lane-reports-agent starts
# them). Each run clones the repository afresh into a folder that is removed
# when the run ends: nothing an earlier session wrote (git settings, Claude
# Code settings, packages) is there.
#
# Two containers per run:
#   inside.sh fetch                               with the network, no token: clones and installs into /home/agent/work
#   inside.sh work <issue number> <model>         no network, no token: the prompt on stdin; leaves /outbox/{fix.patch,agent.log,exit}
# and their checks (lane-reports-agent --check):
#   inside.sh check-fetch <probe port> <host address…>
#   inside.sh check-agent <probe port> <host address…>
set -uo pipefail
mode="${1:-}"
repository="$(cat /lane/repository)"

fail() { echo "FAIL (inside): $*" >&2; exit 1; }
# What both containers must not see: root, the Windows drives, the work
# area, the computer's processes, and a service on its localhost.
contained() {
  local port="$1"
  shift
  [[ "$(id -u)" != 0 ]] || fail "it runs as root in the container"
  [[ ! -e /mnt/c && ! -e /mnt/wslg ]] || fail "a Windows drive or WSL folder is mounted"
  [[ ! -e /srv/lane-reports ]] || fail "the work area is mounted"
  # Its own process list: the command that started it is outside, unseen.
  # (The pattern is written so that grep's own command line does not match it.)
  for cmdline in /proc/[0-9]*/cmdline; do tr '\0' ' ' <"$cmdline" 2>/dev/null; echo; done | grep -q 'lane-reports-agen[t]' && fail "it can see the computer's processes"
  reaches "$port" 10.0.2.2 host.containers.internal host.docker.internal "$@" && fail "it can reach a service on the computer's localhost"
  true
}
# Whether any of these hosts answers on this port.
reaches() {
  node -e '
    const net = require("net");
    const [port, ...hosts] = process.argv.slice(1);
    const tries = [...new Set(hosts)].map((host) => new Promise((resolve) => {
      const socket = net.connect({ host, port: Number(port), timeout: 3000 });
      socket.on("connect", () => { socket.destroy(); resolve(host); });
      socket.on("error", () => resolve(""));
      socket.on("timeout", () => { socket.destroy(); resolve(""); });
    }));
    Promise.all(tries).then((reached) => { reached = reached.filter(Boolean); if (reached.length) { console.error(reached.join(", ")); process.exit(0); } process.exit(1); });
  ' "$@"
}
# The API, as Claude Code is told to find it (ANTHROPIC_BASE_URL): a relay
# from 127.0.0.1:8787 to the token proxy's socket, the container's only way
# out.
relay() {
  [[ -S /proxy/api.sock ]] || fail "the token proxy's socket is missing"
  node -e '
    const net = require("net");
    net.createServer((client) => {
      const proxy = net.connect("/proxy/api.sock");
      client.pipe(proxy);
      proxy.pipe(client);
      client.on("error", () => proxy.destroy());
      proxy.on("error", () => client.destroy());
    }).listen(8787, "127.0.0.1");
  ' &
  for _ in $(seq 50); do (exec 3<>/dev/tcp/127.0.0.1/8787) 2>/dev/null && return 0; sleep 0.1; done
  fail "the relay to the token proxy did not start"
}

case "$mode" in
  check-fetch)
    contained "${@:2}"
    git ls-remote -q "$repository" main >/dev/null || fail "it cannot fetch the repository"
    exit 0
    ;;
  check-agent)
    contained "${@:2}"
    # No token: only the stand-in the proxy replaces.
    [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" && -z "${ANTHROPIC_API_KEY:-}" ]] || fail "a token was passed into the container"
    env | grep -q 'sk-ant-' && fail "a token was passed into the container"
    [[ ! -e /home/agent/.claude-token ]] || fail "the token file is in the container"
    # No network: neither the API itself nor anywhere else.
    reaches 443 api.anthropic.com 1.1.1.1 github.com && fail "it can reach the internet"
    relay
    answer="$(printf 'Reply with the single word ready.' | timeout 120 claude -p --model sonnet 2>&1)"
    [[ "$answer" == *ready* ]] || fail "Claude Code did not answer through the token proxy: ${answer:0:200}"
    exit 0
    ;;
  fetch)
    {
      git clone -q --depth 50 "$repository" /home/agent/work &&
        cd /home/agent/work &&
        npm ci --no-audit --no-fund --loglevel=error
    } >/outbox/setup.log 2>&1 || { echo "clone or install failed" >>/outbox/setup.log; echo 90 >/outbox/exit; }
    exit 0
    ;;
  work)
    model="$3"
    prompt="$(cat)"
    status=0
    cd /home/agent/work || { echo 90 >/outbox/exit; exit 0; }
    relay
    printf '%s\n' "$prompt" | claude -p --model "$model" --dangerously-skip-permissions --add-dir /inbox --add-dir /outbox >/outbox/agent.log 2>&1 || status=$?
    # The patch: what changed under src/ and tests/, new files included.
    git add -A -N -- src tests
    git diff --no-color --no-ext-diff --binary HEAD -- src tests >/outbox/fix.patch
    echo "$status" >/outbox/exit
    ;;
  *)
    echo "inside.sh: fetch, work, check-fetch or check-agent" >&2
    exit 2
    ;;
esac
