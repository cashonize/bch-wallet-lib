/**
 * Vitest setup file for MockNetworkProvider mode.
 * Activated by USE_MOCK_PROVIDER=1. Loads env vars.
 * The mock provider is installed by initProviders() from test/providers.ts.
 */
if (process.env.USE_MOCK_PROVIDER) {
  require("dotenv").config({ path: ".env.regtest", quiet: true });
  require("dotenv").config({ path: ".env.testnet", quiet: true });
}
