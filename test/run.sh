#!/usr/bin/env bash
# End-to-end verification for ssh-tunnel-manager-web on the host (no Docker).
# Starts a test SSH endpoint + target service, boots the app, drives the real
# web UI in headless Chrome, and verifies the forwarded port from the host
# network namespace.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SSH_PORT=2022
TARGET_PORT=8099
LOCAL_PORT=15432
APP_PORT="$(grep -E '^APP_PORT=' .env | head -1 | cut -d= -f2- | tr -d '\r' || true)"
APP_PORT="${APP_PORT:-9999}"
NODE_BIN="$(command -v node)"

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

port_busy() { ss -ltn | grep -qE ":$1\s"; }
wait_port() {
  for _ in $(seq 1 60); do
    port_busy "$1" && return 0
    sleep 0.25
  done
  return 1
}

echo "== preflight"
port_busy "$SSH_PORT" && fail "port $SSH_PORT already busy"
port_busy "$TARGET_PORT" && fail "port $TARGET_PORT already busy"
port_busy "$LOCAL_PORT" && fail "port $LOCAL_PORT already busy"
port_busy "$APP_PORT" && fail "port $APP_PORT already busy"

echo "== keys"
[ -f ssh-keys/id_ed25519_test ] || ssh-keygen -q -t ed25519 -N '' -f ssh-keys/id_ed25519_test -C e2e-test
[ -f test/hostkey_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -f test/hostkey_ed25519 -C e2e-hostkey

echo "== start target service (remote side of the tunnel) on 127.0.0.1:$TARGET_PORT"
python3 test/target_service.py --port "$TARGET_PORT" > test/target.log 2>&1 &
PIDS+=($!)

echo "== start test SSH endpoint on 127.0.0.1:$SSH_PORT"
python3 test/fake_sshd.py --port "$SSH_PORT" --host-key test/hostkey_ed25519 \
  --authorized-key ssh-keys/id_ed25519_test.pub > test/sshd.log 2>&1 &
PIDS+=($!)

wait_port "$TARGET_PORT" || fail "target service did not start"
wait_port "$SSH_PORT" || fail "test sshd did not start"

echo "== record SSH host key into ./data/known_hosts (StrictHostKeyChecking=yes)"
ssh-keyscan -T 5 -p "$SSH_PORT" 127.0.0.1 > data/known_hosts 2> test/keyscan.log
grep -q 'ssh-ed25519' data/known_hosts || fail "ssh-keyscan produced no ed25519 host key"

echo "== remove leftovers from previous test runs"
"$NODE_BIN" -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("data/tunnels.sqlite");
db.prepare("DELETE FROM tunnels WHERE name = ?").run("E2E Local Forward");
db.close();
' 2>/dev/null || true

echo "== start app on 127.0.0.1:$APP_PORT"
# Keep the harness on its own key dir / known_hosts instead of ~/.ssh.
export KEY_DIR="$ROOT/ssh-keys"
export KNOWN_HOSTS_FILE="$ROOT/data/known_hosts"
(cd "$ROOT/app" && exec "$NODE_BIN" server.js > "$ROOT/test/app.log" 2>&1) &
PIDS+=($!)
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$APP_PORT/health" > /dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:$APP_PORT/health" > /dev/null 2>&1 || {
  echo "--- app.log ---"; cat test/app.log >&2 || true
  fail "app did not become healthy"
}

echo "== drive the web UI (headless Chrome)"
CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome}" \
NODE_PATH="${NODE_PATH:+$NODE_PATH:}$(npm root -g)" \
  node test/ui_flow.js || {
    echo "--- app.log (tail) ---"; tail -40 test/app.log >&2 || true
    echo "--- sshd.log (tail) ---"; tail -20 test/sshd.log >&2 || true
    fail "UI flow failed"
  }

echo "== post-checks"
port_busy "$LOCAL_PORT" && fail "local port $LOCAL_PORT still listening after stop"
grep -q 'SSH Tunnel Manager listening' test/app.log || fail "app log missing startup line"
grep -q 'forward request' test/sshd.log || fail "ssh endpoint never received a forward request"
grep -q 'E2E_TARGET_OK' test/target.log || fail "target service never received traffic"

echo
echo "PASS: tunnel created in the UI, started, local port $LOCAL_PORT reachable"
echo "      from the host namespace, traffic verified end-to-end, then stopped."
