const { spawnSync } = require("child_process");

async function getRegtestUtxos(address) {
  try {
    const { ElectrumClient } = await import("@electrum-cash/network");
    const { ElectrumWebSocket } = await import("@electrum-cash/web-socket");

    // Try both localhost and host.docker.internal for Docker compatibility
    for (const host of ["127.0.0.1", "host.docker.internal"]) {
      const socket = new ElectrumWebSocket(host, {
        port: 60003,
        encrypted: false,
        timeoutInMilliSeconds: 5000,
      });
      const client = new ElectrumClient("regtest-setup", "1.5", socket);
      try {
        await client.connect();
      } catch {
        await client.disconnect(true);
        continue;
      }
      const response = await client.request(
        "blockchain.address.listunspent",
        address,
      );
      await client.disconnect(true);
      if (response instanceof Error) throw response;
      return response.length;
    }
    return 0;
  } catch (e) {
    console.log("Error getting block height" + e);
    return 0;
  }
}

function generateBlock(user, password, port, numberOfBlocks, address) {
  const generateArgs = [
    `exec`,
    `regtest`,
    `bitcoin-cli`,
    `--rpcuser=${user}`,
    `--rpcpassword=${password}`,
    `--rpcport=${port}`,
    `generatetoaddress`,
    numberOfBlocks,
    address,
  ];

  const cli = spawnSync(`docker`, generateArgs);
  if (cli.stderr.length > 0) {
    console.log(cli.stderr.toString());
  }
  return JSON.parse(cli.stdout.toString());
}

function pingBchn(user, password, port) {
  const readinessArgs = [
    `exec`,
    `bitcoind`,
    `bitcoin-cli`,
    `-rpcuser=${user || "alice"}`,
    `-rpcpassword=${password || "password"}`,
    `-rpcport=${port || "18443"}`,
    `-rpcconnect=bitcoind`,
    "getblockchaininfo",
  ];
  const response = spawnSync(`docker`, readinessArgs);
  return response.stderr;
}

module.exports = {
  pingBchn,
  generateBlock,
  getRegtestUtxos,
};
