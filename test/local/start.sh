#!/usr/bin/env bash
# Starts the regtest of test/regtest-docker-compose.yml on local BCHN and Fulcrum binaries, no Docker:
# a fresh chain with 815 blocks mined to the test address, RPC alice/password on 18443, Fulcrum on
# 60001 (tcp) and 60003 (ws). Every bind is on 127.0.0.1 and the node never dials a peer.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=test/local/env.sh
source "$here/env.sh"

for binary in "$BITCOIND_PATH" "$FULCRUM_PATH"; do
  if [[ ! -x "$binary" ]]; then
    echo "Not an executable: $binary (set BITCOIND_PATH / FULCRUM_PATH)" >&2
    exit 1
  fi
done

for port in 18443 18444 28332 60001 60003; do
  if ss -ltnH "sport = :$port" | grep -q .; then
    echo "Port $port is in use: another regtest (or this one) is running. Stop it first." >&2
    exit 1
  fi
done

# a fresh chain per start, as the Docker setup's `down -v`; old runs stay until removed by hand
run="$REGTEST_DIR/run-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$run/node" "$run/fulcrum"
ln -sfn "$run" "$REGTEST_DIR/current"

cat >"$run/node/bitcoin.conf" <<EOF
regtest=1
server=1
txindex=1
disablewallet=1
printtoconsole=0

[regtest]
bind=127.0.0.1:18444
rpcbind=127.0.0.1:18443
rpcallowip=127.0.0.1
rpcuser=$RPC_USER
rpcpassword=$RPC_PASS
zmqpubhashblock=tcp://127.0.0.1:28332
zmqpubhashtx=tcp://127.0.0.1:28332
connect=0
dnsseed=0
discover=0
listenonion=0
# a chain left idle for a day would otherwise put the node in initial block download, which Fulcrum waits out
maxtipage=2000000000
EOF

cat >"$run/fulcrum/fulcrum.conf" <<EOF
datadir = $run/fulcrum/db
bitcoind = 127.0.0.1:18443
rpcuser = $RPC_USER
rpcpassword = $RPC_PASS
tcp = 127.0.0.1:60001
ws = 127.0.0.1:60003
peering = false
announce = false
polltime = 0.5
max_clients_per_ip = 50
daemon_passthrough_subnets = 127.0.0.1/8
EOF

echo "Starting bitcoind in $run/node"
"$BITCOIND_PATH" -datadir="$run/node" -daemon >"$run/node/bitcoind.out" 2>&1

for ((i = 0; i < 60; i++)); do
  if rpc getblockchaininfo >/dev/null 2>&1; then break; fi
  sleep 0.5
done
rpc getblockchaininfo >/dev/null

# as the compose file's bitcoin-mine service: the tests spend these coinbases
rpc generatetoaddress "[815, \"$ADDRESS\"]" >/dev/null
echo "Mined 815 blocks to $ADDRESS"

echo "Starting Fulcrum in $run/fulcrum"
setsid "$FULCRUM_PATH" "$run/fulcrum/fulcrum.conf" >"$run/fulcrum/fulcrum.log" 2>&1 </dev/null &
echo $! >"$run/fulcrum/fulcrum.pid"

# Fulcrum opens its ports only once it has caught up with the node
for ((i = 0; i < 120; i++)); do
  if ss -ltnH "sport = :60003" | grep -q .; then
    echo "Regtest up: rpc 127.0.0.1:18443, electrum tcp 127.0.0.1:60001, ws 127.0.0.1:60003"
    exit 0
  fi
  if ! kill -0 "$(cat "$run/fulcrum/fulcrum.pid")" 2>/dev/null; then
    echo "Fulcrum exited; see $run/fulcrum/fulcrum.log" >&2
    exit 1
  fi
  sleep 0.5
done
echo "Fulcrum did not open port 60003 in 60 s; see $run/fulcrum/fulcrum.log" >&2
exit 1
