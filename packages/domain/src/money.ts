const ASSET_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{1,15}$/;
const ATOMIC_AMOUNT_PATTERN = /^(0|[1-9]\d*)$/;

export type Money = Readonly<{
  assetCode: string;
  atomicAmount: bigint;
  scale: number;
}>;

export type SerializedMoney = Readonly<{
  assetCode: string;
  atomicAmount: string;
  scale: number;
}>;

export function parseAtomicAmount(value: string): bigint {
  if (!ATOMIC_AMOUNT_PATTERN.test(value)) {
    throw new TypeError(
      "Atomic amount must be a canonical non-negative base-10 integer string.",
    );
  }

  return BigInt(value);
}

export function createMoney(
  assetCode: string,
  atomicAmount: bigint | string,
  scale: number,
): Money {
  if (!ASSET_CODE_PATTERN.test(assetCode)) {
    throw new TypeError(
      "Asset code must be 2-16 uppercase letters, digits, dots, underscores, or hyphens.",
    );
  }
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 18) {
    throw new TypeError("Money scale must be an integer from 0 through 18.");
  }

  const parsedAmount =
    typeof atomicAmount === "string"
      ? parseAtomicAmount(atomicAmount)
      : atomicAmount;
  if (parsedAmount < 0n) {
    throw new RangeError("Money amount cannot be negative.");
  }

  return Object.freeze({ assetCode, atomicAmount: parsedAmount, scale });
}

export function serializeMoney(money: Money): SerializedMoney {
  return {
    assetCode: money.assetCode,
    atomicAmount: money.atomicAmount.toString(),
    scale: money.scale,
  };
}

export function deserializeMoney(money: SerializedMoney): Money {
  return createMoney(money.assetCode, money.atomicAmount, money.scale);
}

export function assertSameAsset(first: Money, second: Money): void {
  if (first.assetCode !== second.assetCode || first.scale !== second.scale) {
    throw new TypeError("Money values must use the same asset and scale.");
  }
}
