import { describe, expect, it, vi } from "vitest";

import {
  CIRCLE_WALLETS_PROVIDER_KEY,
  ProviderEnvironmentError,
  configuredProvider,
} from "../src/flowpay/configured-provider.ts";

const tokenId = "f311d8ca-cc59-4a61-9c4f-b4b28aeb4ee3";

describe("settlement provider environment", () => {
  it("leaves durable work pending when no provider is selected", () => {
    expect(configuredProvider({})).toBeUndefined();
  });

  it("constructs the explicitly selected simulation provider", () => {
    expect(
      configuredProvider({
        FLOWPAY_PROVIDER: "simulation",
        FLOWPAY_SIMULATION_BEHAVIOR: "PENDING",
      }),
    ).toMatchObject({ key: "simulation" });
  });

  it("constructs the Circle SDK provider only from complete configuration", () => {
    const client = {
      validateAddress: vi.fn(),
      createTransaction: vi.fn(),
      getTransaction: vi.fn(),
    };
    const configured = configuredProvider(
      {
        FLOWPAY_PROVIDER: CIRCLE_WALLETS_PROVIDER_KEY,
        CIRCLE_API_KEY: "test-api-key",
        CIRCLE_ENTITY_SECRET: "0".repeat(64),
        CIRCLE_USDC_TOKEN_ID: tokenId,
      },
      { circleClient: client },
    );

    expect(configured).toMatchObject({ key: CIRCLE_WALLETS_PROVIDER_KEY });
  });

  it("fails closed for incomplete or unsupported provider configuration", () => {
    expect(() =>
      configuredProvider({
        FLOWPAY_PROVIDER: CIRCLE_WALLETS_PROVIDER_KEY,
        CIRCLE_API_KEY: "test-api-key",
      }),
    ).toThrowError(
      new ProviderEnvironmentError(
        "CIRCLE_ENTITY_SECRET is required when FLOWPAY_PROVIDER is circle-wallets.",
      ),
    );
    expect(() => configuredProvider({ FLOWPAY_PROVIDER: "unknown" })).toThrow(
      ProviderEnvironmentError,
    );
  });
});
