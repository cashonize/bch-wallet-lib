// Tests that depend on public services (mainnet and chipnet electrum servers, exchange-rate APIs)
// run only with LIVE_TESTS=1, on the in-memory chain and the Docker regtest alike, so no test run
// reaches a public service unless asked to
export const liveTests = !!process.env.LIVE_TESTS;
