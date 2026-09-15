import { describe, expect, it } from "vitest";

import { SimulationSettlementProvider } from "./index.ts";

const transfer = {
  idempotencyKey: "distribution-1",
  sourceReference: "treasury-1",
  destination: { network: "SIMNET", address: "participant-1" },
  amount: { assetCode: "USD", atomicAmount: "25000", scale: 2 },
  correlationId: "settlement-1",
} as const;

describe("simulation settlement provider", () => {
  it("returns the same transaction for an identical idempotent retry", async () => {
    const provider = new SimulationSettlementProvider("PENDING");

    const first = await provider.submitTransfer(transfer);
    const duplicate = await provider.submitTransfer(transfer);

    expect(duplicate).toEqual(first);
    expect(first).toMatchObject({
      outcome: "ACCEPTED",
      state: "PENDING",
    });
    if (first.outcome !== "ACCEPTED") {
      throw new Error("Expected an accepted simulation transfer.");
    }
    expect(first.providerTransactionId).toMatch(/^sim-[0-9a-f]{16}$/);
  });

  it("rejects reuse of an idempotency key for different input", async () => {
    const provider = new SimulationSettlementProvider();
    await provider.submitTransfer(transfer);

    await expect(
      provider.submitTransfer({
        ...transfer,
        destination: { ...transfer.destination, address: "participant-2" },
      }),
    ).rejects.toThrow(/cannot be reused/);
  });

  it("supports delayed confirmation and status retrieval", async () => {
    const provider = new SimulationSettlementProvider("PENDING");
    const submitted = await provider.submitTransfer(transfer);
    if (submitted.outcome !== "ACCEPTED") {
      throw new Error("Expected an accepted simulation transfer.");
    }

    provider.setTransactionState(submitted.providerTransactionId, "CONFIRMED");

    await expect(
      provider.getTransaction(submitted.providerTransactionId),
    ).resolves.toMatchObject({
      outcome: "FOUND",
      state: "CONFIRMED",
      networkTransactionReference: `simnet:${submitted.providerTransactionId}`,
    });
  });

  it.each(["RETRYABLE_FAILURE", "TERMINAL_FAILURE"] as const)(
    "models %s without creating a provider transaction",
    async (behavior) => {
      const provider = new SimulationSettlementProvider(behavior);
      const result = await provider.submitTransfer(transfer);

      expect(result.outcome).toBe(behavior);
      await expect(provider.getTransaction("sim-1")).resolves.toEqual({
        outcome: "NOT_FOUND",
      });
    },
  );

  it("makes an ambiguous accepted outcome discoverable for reconciliation", async () => {
    const provider = new SimulationSettlementProvider("UNKNOWN_AFTER_ACCEPT");

    const result = await provider.submitTransfer(transfer);

    expect(result).toMatchObject({
      outcome: "UNKNOWN",
    });
    if (!("providerTransactionId" in result) || !result.providerTransactionId) {
      throw new Error("Expected an ambiguous provider transaction identity.");
    }
    await expect(
      provider.getTransaction(result.providerTransactionId),
    ).resolves.toMatchObject({
      outcome: "FOUND",
      state: "PENDING",
    });
  });
});
