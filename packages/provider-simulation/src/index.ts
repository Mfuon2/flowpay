import {
  ProviderIdempotencyConflictError,
  type DestinationValidationResult,
  type ProviderStatusResult,
  type ProviderTransactionState,
  type ProviderTransferInput,
  type SettlementProvider,
  type SubmissionResult,
} from "@flowpay/provider-contract";

export type SimulationBehavior =
  | "PENDING"
  | "CONFIRMED"
  | "RETRYABLE_FAILURE"
  | "TERMINAL_FAILURE"
  | "UNKNOWN_AFTER_ACCEPT";

type StoredSubmission = Readonly<{
  fingerprint: string;
  result: SubmissionResult;
}>;

type StoredTransaction = {
  state: ProviderTransactionState;
  networkTransactionReference?: string;
  failureCode?: string;
};

export class SimulationSettlementProvider implements SettlementProvider {
  readonly #submissions = new Map<string, StoredSubmission>();
  readonly #transactions = new Map<string, StoredTransaction>();

  constructor(readonly behavior: SimulationBehavior = "PENDING") {}

  validateDestination(
    destination: ProviderTransferInput["destination"],
  ): Promise<DestinationValidationResult> {
    const network = destination.network.trim();
    const address = destination.address.trim();
    if (network.length === 0 || address.length === 0) {
      return Promise.resolve({
        valid: false,
        reason: "Network and address are required.",
      });
    }
    return Promise.resolve({ valid: true, normalized: { network, address } });
  }

  submitTransfer(input: ProviderTransferInput): Promise<SubmissionResult> {
    const fingerprint = JSON.stringify(input);
    const existing = this.#submissions.get(input.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(
          new ProviderIdempotencyConflictError(
            "An idempotency key cannot be reused for different transfer input.",
          ),
        );
      }
      return Promise.resolve(existing.result);
    }

    const result = this.#createResult(input.idempotencyKey);
    this.#submissions.set(input.idempotencyKey, { fingerprint, result });
    return Promise.resolve(result);
  }

  getTransaction(providerTransactionId: string): Promise<ProviderStatusResult> {
    const transaction = this.#transactions.get(providerTransactionId);
    if (!transaction) return Promise.resolve({ outcome: "NOT_FOUND" });
    return Promise.resolve({
      outcome: "FOUND",
      providerTransactionId,
      ...transaction,
    });
  }

  setTransactionState(
    providerTransactionId: string,
    state: ProviderTransactionState,
    failureCode?: string,
  ): void {
    const transaction = this.#transactions.get(providerTransactionId);
    if (!transaction) {
      throw new RangeError("Simulation transaction does not exist.");
    }
    transaction.state = state;
    transaction.failureCode = failureCode;
    if (state === "CONFIRMED") {
      transaction.networkTransactionReference ??= `simnet:${providerTransactionId}`;
    }
  }

  #createResult(idempotencyKey: string): SubmissionResult {
    if (this.behavior === "RETRYABLE_FAILURE") {
      return {
        outcome: "RETRYABLE_FAILURE",
        code: "SIM_RETRYABLE",
        message: "Configured retryable simulation failure.",
      };
    }
    if (this.behavior === "TERMINAL_FAILURE") {
      return {
        outcome: "TERMINAL_FAILURE",
        code: "SIM_TERMINAL",
        message: "Configured terminal simulation failure.",
      };
    }

    const providerTransactionId = `sim-${stableIdentifier(idempotencyKey)}`;
    const state = this.behavior === "CONFIRMED" ? "CONFIRMED" : "PENDING";
    const networkTransactionReference =
      state === "CONFIRMED" ? `simnet:${providerTransactionId}` : undefined;
    this.#transactions.set(providerTransactionId, {
      state,
      networkTransactionReference,
    });

    if (this.behavior === "UNKNOWN_AFTER_ACCEPT") {
      return {
        outcome: "UNKNOWN",
        code: "SIM_TIMEOUT",
        message: "Configured timeout after provider acceptance.",
        providerTransactionId,
      };
    }
    return {
      outcome: "ACCEPTED",
      providerTransactionId,
      state,
      networkTransactionReference,
    };
  }
}

function stableIdentifier(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}
