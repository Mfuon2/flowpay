import { describe, expect, it, vi } from "vitest";

import {
  CIRCLE_ARC_TESTNET,
  CircleWalletsProvider,
  CircleWalletsSdkProvider,
} from "./index.ts";

const transactionId = "31ea2a5c-6a98-4eb6-92a0-738e66a59a6f";
const walletId = "c1688d51-4c37-42f0-bf2e-0ac40d658b53";
const tokenId = "f311d8ca-cc59-4a61-9c4f-b4b28aeb4ee3";
const idempotencyKey = "d8325d0d-8b3f-48c6-9a19-71cff91b818b";

function input(atomicAmount = "1000000") {
  return {
    idempotencyKey,
    sourceReference: walletId,
    destination: {
      network: CIRCLE_ARC_TESTNET,
      address: "0xca9142d0b9804ef5e239d3bc1c7aa0d1c74e7350",
    },
    amount: { assetCode: "USDC", atomicAmount, scale: 6 },
    correlationId: "correlation-1",
  } as const;
}

describe("Circle Wallets Arc Testnet provider", () => {
  it("validates an Arc destination through Circle", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: { isValid: true } }));
    const provider = configured(fetcher);
    await expect(
      provider.validateDestination(input().destination),
    ).resolves.toEqual({
      valid: true,
      normalized: input().destination,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.circle.test/v1/w3s/transactions/validateAddress",
    );
  });

  it("submits exact USDC human units with UUIDv4 idempotency and fresh authorization", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ data: { id: transactionId, state: "INITIATED" } }),
      );
    const ciphertext = vi.fn().mockResolvedValue("single-use-ciphertext");
    const provider = configured(fetcher, ciphertext);
    await expect(provider.submitTransfer(input("25000123"))).resolves.toEqual({
      outcome: "ACCEPTED",
      providerTransactionId: transactionId,
      state: "PENDING",
    });
    expect(ciphertext).toHaveBeenCalledOnce();
    const request = fetcher.mock.calls[0]?.[1];
    if (typeof request?.body !== "string") {
      throw new TypeError("Expected a serialized Circle request body.");
    }
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      idempotencyKey,
      walletId,
      tokenId,
      amounts: ["25.000123"],
      feeLevel: "MEDIUM",
      entitySecretCiphertext: "single-use-ciphertext",
    });
    expect(JSON.stringify(body)).not.toContain("api-key");
  });

  it("requires USDC scale six and Circle-compatible idempotency before authorization", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const ciphertext = vi.fn().mockResolvedValue("ciphertext");
    const provider = configured(fetcher, ciphertext);
    await expect(
      provider.submitTransfer({
        ...input(),
        amount: { assetCode: "USD", atomicAmount: "100", scale: 2 },
      }),
    ).resolves.toMatchObject({
      outcome: "TERMINAL_FAILURE",
      code: "CIRCLE_ASSET_PRECISION",
    });
    await expect(
      provider.submitTransfer({ ...input(), idempotencyKey: "not-a-uuid" }),
    ).resolves.toMatchObject({
      outcome: "TERMINAL_FAILURE",
      code: "CIRCLE_IDEMPOTENCY_KEY",
    });
    expect(ciphertext).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps only COMPLETE to confirmed and preserves pending/stuck evidence", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: {
            transaction: {
              id: transactionId,
              state: "CONFIRMED",
              txHash: "0xabc",
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            transaction: {
              id: transactionId,
              state: "COMPLETE",
              txHash: "0xabc",
            },
          },
        }),
      );
    const provider = configured(fetcher);
    await expect(provider.getTransaction(transactionId)).resolves.toEqual({
      outcome: "FOUND",
      providerTransactionId: transactionId,
      state: "PENDING",
      networkTransactionReference: "0xabc",
    });
    await expect(provider.getTransaction(transactionId)).resolves.toEqual({
      outcome: "FOUND",
      providerTransactionId: transactionId,
      state: "CONFIRMED",
      networkTransactionReference: "0xabc",
    });
  });

  it("maps rate limits to explicit retry and invalid requests to terminal failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 400 }));
    const provider = configured(fetcher);
    await expect(provider.submitTransfer(input())).resolves.toMatchObject({
      outcome: "RETRYABLE_FAILURE",
      code: "CIRCLE_HTTP_429",
    });
    await expect(provider.submitTransfer(input())).resolves.toMatchObject({
      outcome: "TERMINAL_FAILURE",
      code: "CIRCLE_HTTP_400",
    });
  });
});

describe("Circle Wallets official SDK provider", () => {
  it("rejects malformed entity-secret material before constructing a client", () => {
    expect(
      () =>
        new CircleWalletsSdkProvider({
          apiKey: "test-api-key",
          entitySecret: "not-secret-material",
          usdcTokenId: tokenId,
        }),
    ).toThrow(/32-byte hexadecimal/);
  });

  it("validates Arc destinations through the SDK", async () => {
    const client = sdkClient();
    client.validateAddress.mockResolvedValue({ data: { isValid: true } });
    const provider = sdkConfigured(client);

    await expect(
      provider.validateDestination(input().destination),
    ).resolves.toEqual({
      valid: true,
      normalized: input().destination,
    });
    expect(client.validateAddress).toHaveBeenCalledWith({
      address: input().destination.address,
      blockchain: CIRCLE_ARC_TESTNET,
    });
  });

  it("submits exact USDC units with one stable Circle request identity", async () => {
    const client = sdkClient();
    client.createTransaction.mockResolvedValue({
      data: { id: transactionId, state: "INITIATED" },
    });
    const provider = sdkConfigured(client);

    await expect(provider.submitTransfer(input("1000001"))).resolves.toEqual({
      outcome: "ACCEPTED",
      providerTransactionId: transactionId,
      state: "PENDING",
    });
    expect(client.createTransaction).toHaveBeenCalledWith({
      walletId,
      tokenId,
      destinationAddress: input().destination.address,
      amount: ["1.000001"],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey,
      xRequestId: idempotencyKey,
    });
  });

  it("maps terminal and non-terminal Circle transaction states", async () => {
    const client = sdkClient();
    client.getTransaction
      .mockResolvedValueOnce({
        data: { transaction: { state: "COMPLETE", txHash: "0xabc" } },
      })
      .mockResolvedValueOnce({
        data: { transaction: { state: "FAILED" } },
      })
      .mockResolvedValueOnce({
        data: { transaction: { state: "CANCELLED" } },
      })
      .mockResolvedValueOnce({
        data: { transaction: { state: "STUCK", txHash: "0xdef" } },
      });
    const provider = sdkConfigured(client);

    await expect(provider.getTransaction(transactionId)).resolves.toMatchObject(
      {
        outcome: "FOUND",
        state: "CONFIRMED",
        networkTransactionReference: "0xabc",
      },
    );
    await expect(provider.getTransaction(transactionId)).resolves.toMatchObject(
      { outcome: "FOUND", state: "FAILED", failureCode: "CIRCLE_FAILED" },
    );
    await expect(provider.getTransaction(transactionId)).resolves.toMatchObject(
      {
        outcome: "FOUND",
        state: "CANCELLED",
        failureCode: "CIRCLE_CANCELLED",
      },
    );
    await expect(provider.getTransaction(transactionId)).resolves.toMatchObject(
      {
        outcome: "FOUND",
        state: "PENDING",
        failureCode: "CIRCLE_STUCK",
        networkTransactionReference: "0xdef",
      },
    );
  });

  it("maps SDK HTTP failures without retrying rejected requests", async () => {
    const client = sdkClient();
    client.createTransaction
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockRejectedValueOnce({ response: { status: 400 } });
    client.getTransaction.mockRejectedValueOnce({ response: { status: 404 } });
    const provider = sdkConfigured(client);

    await expect(provider.submitTransfer(input())).resolves.toMatchObject({
      outcome: "RETRYABLE_FAILURE",
      code: "CIRCLE_HTTP_429",
    });
    await expect(provider.submitTransfer(input())).resolves.toMatchObject({
      outcome: "TERMINAL_FAILURE",
      code: "CIRCLE_HTTP_400",
    });
    await expect(provider.getTransaction(transactionId)).resolves.toEqual({
      outcome: "NOT_FOUND",
    });
  });
});

function configured(
  fetcher: typeof fetch,
  entitySecretCiphertext = vi.fn().mockResolvedValue("ciphertext"),
) {
  return new CircleWalletsProvider({
    apiKey: "test-api-key",
    usdcTokenId: tokenId,
    entitySecretCiphertext,
    baseUrl: "https://api.circle.test",
    fetcher,
  });
}

function sdkClient() {
  return {
    validateAddress: vi.fn(),
    createTransaction: vi.fn(),
    getTransaction: vi.fn(),
  };
}

function sdkConfigured(client: ReturnType<typeof sdkClient>) {
  return new CircleWalletsSdkProvider({
    apiKey: "test-api-key",
    entitySecret: "0".repeat(64),
    usdcTokenId: tokenId,
    client,
  });
}
