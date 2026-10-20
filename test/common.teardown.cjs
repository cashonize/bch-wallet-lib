const child_process = require("child_process");

module.exports = async function (cwd) {
  if (cwd instanceof Object || cwd === undefined) {
    cwd = ".";
  }

  if (process.env.SKIP_REGTEST_INIT || process.env.USE_MOCK_PROVIDER) {
    return;
  }

  // Stop regtest server
  let stopScript = "./test/docker/stop.sh";
  if (process.env.REGTEST_BACKEND === "local")
    stopScript = "./test/local/stop.sh";
  child_process.spawnSync(stopScript, null, {
    shell: false,
    stdio: "inherit",
    cwd: cwd,
  });
  console.log("stopped regtest node");
};
