import type {
  DestinationValidationResult,
  ProviderStatusResult,
  ProviderTransferInput,
  SettlementProvider,
  SubmissionResult,
} from "@flowpay/provider-contract";
import { CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

export const CIRCLE_ARC_TESTNET = "ARC-TESTNET";

export type CircleWalletsConfiguration = Readonly<{
  apiKey: string;
  usdcTokenId: string;
  entitySecretCiphertext: () => Promise<string>;
  baseUrl?: string;
  fetcher?: typeof fetch;
  feeLevel?: "LOW" | "MEDIUM" | "HIGH";
}>;

export class CircleWalletsConfigurationError extends Error {
  override readonly name = "CircleWalletsConfigurationError";
}

export class CircleWalletsResponseError extends Error {
  override readonly name = "CircleWalletsResponseError";
}

export class CircleWalletsProvider implements SettlementProvider {
  readonly #apiKey: string;
  readonly #usdcTokenId: string;
  readonly #entitySecretCiphertext: () => Promise<string>;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #feeLevel: "LOW" | "MEDIUM" | "HIGH";

  constructor(configuration: CircleWalletsConfiguration) {
    this.#apiKey = required("Circle API key", configuration.apiKey);
    this.#usdcTokenId = uuid("Circle USDC token ID", configuration.usdcTokenId);
    this.#entitySecretCiphertext = configuration.entitySecretCiphertext;
    this.#baseUrl = (configuration.baseUrl ?? "https://api.circle.com").replace(
      /\/$/,
      "",
    );
    this.#fetch = configuration.fetcher ?? fetch;
    this.#feeLevel = configuration.feeLevel ?? "MEDIUM";
  }

  async validateDestination(
    destination: ProviderTransferInput["destination"],
  ): Promise<DestinationValidationResult> {
    if (destination.network !== CIRCLE_ARC_TESTNET) {
      return {
        valid: false,
        reason: `Circle Arc adapter requires ${CIRCLE_ARC_TESTNET}.`,
      };
    }
    const address = destination.address.trim();
    if (address.length === 0) {
      return { valid: false, reason: "Destination address is required." };
    }
    const response = await this.#request(
      "/v1/w3s/transactions/validateAddress",
      {
        method: "POST",
        body: JSON.stringify({
          address,
          blockchain: CIRCLE_ARC_TESTNET,
        }),
      },
    );
    const body = await responseJson(response);
    const isValid = nestedBoolean(body, "data", "isValid");
    return isValid
      ? { valid: true, normalized: { network: CIRCLE_ARC_TESTNET, address } }
      : { valid: false, reason: "Circle rejected the destination address." };
  }

  async submitTransfer(
    input: ProviderTransferInput,
  ): Promise<SubmissionResult> {
    if (input.destination.network !== CIRCLE_ARC_TESTNET) {
      return terminal("CIRCLE_NETWORK", "Circle Arc network does not match.");
    }
    if (input.amount.assetCode !== "USDC" || input.amount.scale !== 6) {
      return terminal(
        "CIRCLE_ASSET_PRECISION",
        "Circle Arc transfers require USDC with scale 6.",
      );
    }
    if (!UUID_V4.test(input.idempotencyKey)) {
      return terminal(
        "CIRCLE_IDEMPOTENCY_KEY",
        "Circle Wallets requires a UUIDv4 idempotency key.",
      );
    }
    const entitySecretCiphertext = required(
      "Circle entity secret ciphertext",
      await this.#entitySecretCiphertext(),
    );
    const response = await this.#request(
      "/v1/w3s/developer/transactions/transfer",
      {
        method: "POST",
        headers: { "x-request-id": input.idempotencyKey },
        body: JSON.stringify({
          idempotencyKey: input.idempotencyKey,
          walletId: uuid("Circle source wallet ID", input.sourceReference),
          tokenId: this.#usdcTokenId,
          destinationAddress: input.destination.address,
          amounts: [atomicToDecimal(input.amount.atomicAmount, 6)],
          feeLevel: this.#feeLevel,
          entitySecretCiphertext,
        }),
      },
    );
    if (!response.ok) return submissionFailure(response);
    const body = await responseJson(response);
    const id = nestedString(body, "data", "id");
    const state = nestedString(body, "data", "state");
    if (!id || !state) {
      throw new CircleWalletsResponseError(
        "Circle transfer response omitted transaction identity or state.",
      );
    }
    if (state === "FAILED" || state === "DENIED" || state === "CANCELLED") {
      return terminal(`CIRCLE_${state}`, `Circle returned ${state}.`);
    }
    return {
      outcome: "ACCEPTED",
      providerTransactionId: id,
      state: state === "COMPLETE" ? "CONFIRMED" : "PENDING",
    };
  }

  async getTransaction(
    providerTransactionId: string,
  ): Promise<ProviderStatusResult> {
    const id = uuid("Circle transaction ID", providerTransactionId);
    const response = await this.#request(
      `/v1/w3s/transactions/${encodeURIComponent(id)}`,
    );
    if (response.status === 404) return { outcome: "NOT_FOUND" };
    const body = await responseJson(response);
    const state = nestedString(body, "data", "transaction", "state");
    if (!state) {
      throw new CircleWalletsResponseError(
        "Circle transaction response omitted its state.",
      );
    }
    const txHash = nestedString(body, "data", "transaction", "txHash");
    if (state === "COMPLETE") {
      return {
        outcome: "FOUND",
        providerTransactionId: id,
        state: "CONFIRMED",
        ...(txHash ? { networkTransactionReference: txHash } : {}),
      };
    }
    if (state === "FAILED" || state === "DENIED") {
      return {
        outcome: "FOUND",
        providerTransactionId: id,
        state: "FAILED",
        failureCode: `CIRCLE_${state}`,
      };
    }
    if (state === "CANCELLED") {
      return {
        outcome: "FOUND",
        providerTransactionId: id,
        state: "CANCELLED",
        failureCode: "CIRCLE_CANCELLED",
      };
    }
    return {
      outcome: "FOUND",
      providerTransactionId: id,
      state: "PENDING",
      ...(txHash ? { networkTransactionReference: txHash } : {}),
      ...(state === "STUCK" ? { failureCode: "CIRCLE_STUCK" } : {}),
    };
  }

  #request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.#apiKey}`);
    headers.set("content-type", "application/json");
    return this.#fetch(`${this.#baseUrl}${path}`, { ...init, headers });
  }
}

type CircleSdkClient = Readonly<{
  validateAddress(input: {
    address: string;
    blockchain: string;
  }): Promise<{ data?: { isValid?: boolean } }>;
  createTransaction(input: {
    walletId: string;
    tokenId: string;
    destinationAddress: string;
    amount: string[];
    fee: {
      type: "level";
      config: { feeLevel: "LOW" | "MEDIUM" | "HIGH" };
    };
    idempotencyKey: string;
    xRequestId: string;
  }): Promise<{ data?: { id?: string; state?: string } }>;
  getTransaction(input: { id: string; xRequestId?: string }): Promise<{
    data?: { transaction?: { state?: string; txHash?: string } };
  }>;
}>;

export type CircleWalletsSdkConfiguration = Readonly<{
  apiKey: string;
  entitySecret: string;
  usdcTokenId: string;
  baseUrl?: string;
  feeLevel?: "LOW" | "MEDIUM" | "HIGH";
  client?: CircleSdkClient;
}>;

/**
 * Production-oriented adapter using Circle's current SDK so every sensitive
 * request receives a fresh entity-secret ciphertext automatically.
 */
export class CircleWalletsSdkProvider implements SettlementProvider {
  readonly #client: CircleSdkClient;
  readonly #usdcTokenId: string;
  readonly #feeLevel: "LOW" | "MEDIUM" | "HIGH";

  constructor(configuration: CircleWalletsSdkConfiguration) {
    const apiKey = required("Circle API key", configuration.apiKey);
    const entitySecret = circleEntitySecret(configuration.entitySecret);
    this.#usdcTokenId = uuid("Circle USDC token ID", configuration.usdcTokenId);
    this.#feeLevel = configuration.feeLevel ?? "MEDIUM";
    this.#client =
      configuration.client ??
      new CircleDeveloperControlledWalletsClient({
        apiKey,
        entitySecret,
        ...(configuration.baseUrl ? { baseUrl: configuration.baseUrl } : {}),
        userAgent: "QeSuite-FlowPay/0.1",
      });
  }

  async validateDestination(
    destination: ProviderTransferInput["destination"],
  ): Promise<DestinationValidationResult> {
    if (destination.network !== CIRCLE_ARC_TESTNET) {
      return {
        valid: false,
        reason: `Circle Arc adapter requires ${CIRCLE_ARC_TESTNET}.`,
      };
    }
    const address = destination.address.trim();
    if (!address) return { valid: false, reason: "Destination is required." };
    try {
      const response = await this.#client.validateAddress({
        address,
        blockchain: CIRCLE_ARC_TESTNET,
      });
      return response.data?.isValid === true
        ? { valid: true, normalized: { network: CIRCLE_ARC_TESTNET, address } }
        : { valid: false, reason: "Circle rejected the destination address." };
    } catch (error) {
      throw sdkResponseError("address validation", error);
    }
  }

  async submitTransfer(
    input: ProviderTransferInput,
  ): Promise<SubmissionResult> {
    if (input.destination.network !== CIRCLE_ARC_TESTNET) {
      return terminal("CIRCLE_NETWORK", "Circle Arc network does not match.");
    }
    if (input.amount.assetCode !== "USDC" || input.amount.scale !== 6) {
      return terminal(
        "CIRCLE_ASSET_PRECISION",
        "Circle Arc transfers require USDC with scale 6.",
      );
    }
    if (!UUID_V4.test(input.idempotencyKey)) {
      return terminal(
        "CIRCLE_IDEMPOTENCY_KEY",
        "Circle Wallets requires a UUIDv4 idempotency key.",
      );
    }
    try {
      const response = await this.#client.createTransaction({
        walletId: uuid("Circle source wallet ID", input.sourceReference),
        tokenId: this.#usdcTokenId,
        destinationAddress: input.destination.address,
        amount: [atomicToDecimal(input.amount.atomicAmount, 6)],
        fee: { type: "level", config: { feeLevel: this.#feeLevel } },
        idempotencyKey: input.idempotencyKey,
        xRequestId: input.idempotencyKey,
      });
      const id = response.data?.id;
      const state = response.data?.state;
      if (!id || !state) {
        throw new CircleWalletsResponseError(
          "Circle SDK transfer response omitted transaction identity or state.",
        );
      }
      if (isTerminalFailure(state)) {
        return terminal(`CIRCLE_${state}`, `Circle returned ${state}.`);
      }
      return {
        outcome: "ACCEPTED",
        providerTransactionId: id,
        state: state === "COMPLETE" ? "CONFIRMED" : "PENDING",
      };
    } catch (error) {
      if (error instanceof CircleWalletsResponseError) throw error;
      return sdkSubmissionFailure(error);
    }
  }

  async getTransaction(
    providerTransactionId: string,
  ): Promise<ProviderStatusResult> {
    const id = uuid("Circle transaction ID", providerTransactionId);
    try {
      const response = await this.#client.getTransaction({
        id,
        xRequestId: crypto.randomUUID(),
      });
      const state = response.data?.transaction?.state;
      const txHash = response.data?.transaction?.txHash;
      if (!state) {
        throw new CircleWalletsResponseError(
          "Circle SDK transaction response omitted its state.",
        );
      }
      if (state === "COMPLETE") {
        return {
          outcome: "FOUND",
          providerTransactionId: id,
          state: "CONFIRMED",
          ...(txHash ? { networkTransactionReference: txHash } : {}),
        };
      }
      if (state === "FAILED" || state === "DENIED") {
        return {
          outcome: "FOUND",
          providerTransactionId: id,
          state: "FAILED",
          failureCode: `CIRCLE_${state}`,
        };
      }
      if (state === "CANCELLED") {
        return {
          outcome: "FOUND",
          providerTransactionId: id,
          state: "CANCELLED",
          failureCode: "CIRCLE_CANCELLED",
        };
      }
      return {
        outcome: "FOUND",
        providerTransactionId: id,
        state: "PENDING",
        ...(txHash ? { networkTransactionReference: txHash } : {}),
        ...(state === "STUCK" ? { failureCode: "CIRCLE_STUCK" } : {}),
      };
    } catch (error) {
      if (error instanceof CircleWalletsResponseError) throw error;
      if (httpStatus(error) === 404) return { outcome: "NOT_FOUND" };
      throw sdkResponseError("transaction lookup", error);
    }
  }
}

function sdkSubmissionFailure(error: unknown): SubmissionResult {
  const status = httpStatus(error);
  const retryable =
    status === undefined || status === 408 || status === 429 || status >= 500;
  return retryable
    ? {
        outcome: "RETRYABLE_FAILURE",
        code: status ? `CIRCLE_HTTP_${status}` : "CIRCLE_NETWORK_ERROR",
        message: "Circle SDK transfer request did not complete successfully.",
      }
    : {
        outcome: "TERMINAL_FAILURE",
        code: `CIRCLE_HTTP_${status}`,
        message: "Circle SDK rejected the transfer request.",
      };
}

function sdkResponseError(operation: string, error: unknown) {
  const status = httpStatus(error);
  return new CircleWalletsResponseError(
    `Circle SDK ${operation} failed${status ? ` with HTTP ${status}` : ""}.`,
  );
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (
    "status" in error &&
    typeof error.status === "number" &&
    Number.isSafeInteger(error.status)
  ) {
    return error.status;
  }
  if (
    "response" in error &&
    typeof error.response === "object" &&
    error.response !== null &&
    "status" in error.response &&
    typeof error.response.status === "number" &&
    Number.isSafeInteger(error.response.status)
  ) {
    return error.response.status;
  }
  return undefined;
}

function isTerminalFailure(state: string) {
  return state === "FAILED" || state === "DENIED" || state === "CANCELLED";
}

function submissionFailure(response: Response): SubmissionResult {
  const message = `Circle transfer request failed with HTTP ${response.status}.`;
  return response.status === 429 || response.status >= 500
    ? {
        outcome: "RETRYABLE_FAILURE",
        code: `CIRCLE_HTTP_${response.status}`,
        message,
      }
    : {
        outcome: "TERMINAL_FAILURE",
        code: `CIRCLE_HTTP_${response.status}`,
        message,
      };
}

function terminal(code: string, message: string): SubmissionResult {
  return { outcome: "TERMINAL_FAILURE", code, message };
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new CircleWalletsResponseError(
      `Circle request failed with HTTP ${response.status}.`,
    );
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new CircleWalletsResponseError("Circle returned invalid JSON.");
  }
}

function nestedString(value: unknown, ...path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

function nestedBoolean(value: unknown, ...path: string[]): boolean {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current === true;
}

function atomicToDecimal(value: string, scale: number): string {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new CircleWalletsConfigurationError(
      "Transfer amount must be a canonical atomic integer.",
    );
  }
  const padded = value.padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function required(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized)
    throw new CircleWalletsConfigurationError(`${label} is required.`);
  return normalized;
}

function uuid(label: string, value: string): string {
  const normalized = required(label, value);
  if (!UUID.test(normalized)) {
    throw new CircleWalletsConfigurationError(`${label} must be a UUID.`);
  }
  return normalized;
}

function circleEntitySecret(value: string): string {
  const normalized = required("Circle entity secret", value);
  if (!/^[0-9a-f]{64}$/i.test(normalized)) {
    throw new CircleWalletsConfigurationError(
      "Circle entity secret must be a 32-byte hexadecimal value.",
    );
  }
  return normalized;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
