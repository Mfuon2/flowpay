import { describe, expect, it } from "vitest";

import {
  deploymentVariables,
  parseSecretNames,
  requiredSecretNames,
} from "./deploy-config.mjs";

describe("deployment configuration", () => {
  it("requires Access configuration for every deployment", () => {
    expect(requiredSecretNames("simulation")).toEqual([
      "TEAM_DOMAIN",
      "POLICY_AUD",
    ]);
  });

  it("requires all Circle bindings for an Arc Testnet deployment", () => {
    expect(requiredSecretNames("circle-wallets")).toEqual([
      "TEAM_DOMAIN",
      "POLICY_AUD",
      "CIRCLE_API_KEY",
      "CIRCLE_ENTITY_SECRET",
      "CIRCLE_USDC_TOKEN_ID",
    ]);
  });

  it("parses Wrangler secret metadata without reading secret values", () => {
    expect([
      ...parseSecretNames('[{"name":"CIRCLE_API_KEY","type":"secret_text"}]'),
    ]).toEqual(["CIRCLE_API_KEY"]);
  });

  it("passes only non-sensitive provider switches to Wrangler deploy", () => {
    expect(deploymentVariables("circle-wallets")).toEqual([
      "FLOWPAY_PROVIDER:circle-wallets",
    ]);
    expect(deploymentVariables("simulation")).toEqual([
      "FLOWPAY_PROVIDER:simulation",
      "FLOWPAY_SIMULATION_BEHAVIOR:CONFIRMED",
    ]);
  });
});
