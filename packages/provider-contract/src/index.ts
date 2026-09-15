import type { SerializedMoney } from "@flowpay/domain";

export type ProviderDestination = Readonly<{
  network: string;
  address: string;
}>;

export type ProviderTransferInput = Readonly<{
  idempotencyKey: string;
  sourceReference: string;
  destination: ProviderDestination;
  amount: SerializedMoney;
  correlationId: string;
}>;

export type ProviderTransactionState =
  | "PENDING"
  | "CONFIRMED"
  | "FAILED"
  | "CANCELLED";

export type AcceptedSubmission = Readonly<{
  outcome: "ACCEPTED";
  providerTransactionId: string;
  state: "PENDING" | "CONFIRMED";
  networkTransactionReference?: string;
}>;

export type SubmissionResult =
  | AcceptedSubmission
  | Readonly<{
      outcome: "RETRYABLE_FAILURE" | "TERMINAL_FAILURE";
      code: string;
      message: string;
    }>
  | Readonly<{
      outcome: "UNKNOWN";
      code: string;
      message: string;
      providerTransactionId?: string;
    }>;

export type ProviderStatusResult =
  | Readonly<{ outcome: "NOT_FOUND" }>
  | Readonly<{
      outcome: "FOUND";
      providerTransactionId: string;
      state: ProviderTransactionState;
      networkTransactionReference?: string;
      failureCode?: string;
    }>;

export type DestinationValidationResult =
  | Readonly<{ valid: true; normalized: ProviderDestination }>
  | Readonly<{ valid: false; reason: string }>;

export interface SettlementProvider {
  validateDestination(
    destination: ProviderDestination,
  ): Promise<DestinationValidationResult>;
  submitTransfer(input: ProviderTransferInput): Promise<SubmissionResult>;
  getTransaction(providerTransactionId: string): Promise<ProviderStatusResult>;
}

export class ProviderIdempotencyConflictError extends Error {
  override readonly name = "ProviderIdempotencyConflictError";
}
