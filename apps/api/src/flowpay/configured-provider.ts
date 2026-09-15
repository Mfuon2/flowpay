import {
  CircleWalletsSdkProvider,
  type CircleWalletsSdkConfiguration,
} from "@flowpay/provider-circle-wallets";
import type { SettlementProvider } from "@flowpay/provider-contract";
import {
  SimulationSettlementProvider,
  type SimulationBehavior,
} from "@flowpay/provider-simulation";

export const CIRCLE_WALLETS_PROVIDER_KEY = "circle-wallets";

export type ConfiguredProvider = Readonly<{
  key: string;
  provider: SettlementProvider;
}>;

export type ProviderEnvironment = Readonly<{
  FLOWPAY_PROVIDER?: string;
  FLOWPAY_SIMULATION_BEHAVIOR?: string;
  CIRCLE_API_KEY?: string;
  CIRCLE_ENTITY_SECRET?: string;
  CIRCLE_USDC_TOKEN_ID?: string;
  CIRCLE_API_BASE_URL?: string;
}>;

export class ProviderEnvironmentError extends Error {
  override readonly name = "ProviderEnvironmentError";
}

/**
 * Provider activation is explicit. Missing configuration leaves settlement work
 * durable and pending; partial or unsupported configuration fails closed.
 */
export function configuredProvider(
  env: ProviderEnvironment,
  options: Readonly<{
    circleClient?: CircleWalletsSdkConfiguration["client"];
  }> = {},
): ConfiguredProvider | undefined {
  const key = env.FLOWPAY_PROVIDER?.trim();
  if (!key) return undefined;
  if (key === "simulation") {
    return {
      key,
      provider: new SimulationSettlementProvider(simulationBehavior(env)),
    };
  }
  if (key === CIRCLE_WALLETS_PROVIDER_KEY) {
    return {
      key,
      provider: new CircleWalletsSdkProvider({
        apiKey: environmentValue(env.CIRCLE_API_KEY, "CIRCLE_API_KEY"),
        entitySecret: environmentValue(
          env.CIRCLE_ENTITY_SECRET,
          "CIRCLE_ENTITY_SECRET",
        ),
        usdcTokenId: environmentValue(
          env.CIRCLE_USDC_TOKEN_ID,
          "CIRCLE_USDC_TOKEN_ID",
        ),
        ...(env.CIRCLE_API_BASE_URL
          ? { baseUrl: env.CIRCLE_API_BASE_URL }
          : {}),
        ...(options.circleClient ? { client: options.circleClient } : {}),
      }),
    };
  }
  throw new ProviderEnvironmentError(
    `FLOWPAY_PROVIDER '${key}' is not supported.`,
  );
}

function simulationBehavior(env: ProviderEnvironment): SimulationBehavior {
  const behavior = env.FLOWPAY_SIMULATION_BEHAVIOR ?? "CONFIRMED";
  if (
    behavior === "PENDING" ||
    behavior === "CONFIRMED" ||
    behavior === "RETRYABLE_FAILURE" ||
    behavior === "TERMINAL_FAILURE" ||
    behavior === "UNKNOWN_AFTER_ACCEPT"
  ) {
    return behavior;
  }
  throw new ProviderEnvironmentError(
    "FLOWPAY_SIMULATION_BEHAVIOR is not supported.",
  );
}

function environmentValue(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new ProviderEnvironmentError(
      `${name} is required when FLOWPAY_PROVIDER is ${CIRCLE_WALLETS_PROVIDER_KEY}.`,
    );
  }
  return value;
}
