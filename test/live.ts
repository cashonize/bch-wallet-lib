// Tests that depend on public services (mainnet and chipnet electrum servers, exchange-rate APIs)
// run on the Docker regtest, and on the in-memory chain only with LIVE_TESTS=1, so pnpm test and
// pnpm test:browser run offline
export const liveTests =
  !process.env.USE_MOCK_PROVIDER || !!process.env.LIVE_TESTS;
