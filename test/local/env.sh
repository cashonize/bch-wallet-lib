# Shared by start.sh and stop.sh: binaries, the data directory and the node's RPC.
BITCOIND_PATH="${BITCOIND_PATH:-$HOME/BCH-infra/bchn/bin/bitcoind}"
FULCRUM_PATH="${FULCRUM_PATH:-$HOME/BCH-infra/fulcrum/Fulcrum}"
REGTEST_DIR="${REGTEST_DIR:-$HOME/BCH-infra/regtest-bch-wallet-lib}"

# the credentials and address of .env.regtest, which the tests read
RPC_USER=alice
RPC_PASS=password
ADDRESS=bchreg:qpttdv3qg2usm4nm7talhxhl05mlhms3ys43u76rn0

rpc() {
  local method="$1" params="${2:-[]}"
  curl -sf --user "$RPC_USER:$RPC_PASS" -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"1.0\",\"id\":\"local\",\"method\":\"$method\",\"params\":$params}" \
    http://127.0.0.1:18443/
}

# paryon_regtest's default directory holds other projects' chains and snapshots
if [[ "$(realpath -m "$REGTEST_DIR")" == "$(realpath -m "$HOME/BCH-infra/regtest")" ]]; then
  echo "REGTEST_DIR must not be paryon_regtest's $HOME/BCH-infra/regtest" >&2
  exit 1
fi
