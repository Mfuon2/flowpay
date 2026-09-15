export const DEPLOYMENT_PROVIDERS = ["simulation", "circle-wallets"];

export const SECRET_REQUIREMENTS = Object.freeze({
  TEAM_DOMAIN:
    "Cloudflare Zero Trust team URL, for example https://your-team.cloudflareaccess.com",
  POLICY_AUD: "Audience (AUD) tag of the FlowPay Access application",
  CIRCLE_API_KEY:
    "Restricted Circle Developer API key with Wallets read/write access",
  CIRCLE_ENTITY_SECRET:
    "Registered 32-byte Circle entity secret; keep its recovery file separately",
  CIRCLE_USDC_TOKEN_ID:
    "Circle token UUID for USDC on ARC-TESTNET; this is not the contract address",
});

export function requiredSecretNames(provider) {
  assertProvider(provider);
  const common = ["TEAM_DOMAIN", "POLICY_AUD"];
  return provider === "circle-wallets"
    ? [
        ...common,
        "CIRCLE_API_KEY",
        "CIRCLE_ENTITY_SECRET",
        "CIRCLE_USDC_TOKEN_ID",
      ]
    : common;
}

export function parseSecretNames(output) {
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed)) {
    throw new Error("Wrangler returned an unexpected secret-list response.");
  }
  return new Set(
    parsed.flatMap((entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "name" in entry &&
      typeof entry.name === "string"
        ? [entry.name]
        : [],
    ),
  );
}

export function deploymentVariables(provider) {
  assertProvider(provider);
  return provider === "simulation"
    ? ["FLOWPAY_PROVIDER:simulation", "FLOWPAY_SIMULATION_BEHAVIOR:CONFIRMED"]
    : ["FLOWPAY_PROVIDER:circle-wallets"];
}

export function assertProvider(provider) {
  if (!DEPLOYMENT_PROVIDERS.includes(provider)) {
    throw new Error(
      `Provider must be one of: ${DEPLOYMENT_PROVIDERS.join(", ")}.`,
    );
  }
}
