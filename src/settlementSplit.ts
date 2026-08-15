import { formatUnits } from "viem";

export type ValidSettlementSplit = {
  status: "valid";
  totalBaseUnits: string;
  laborBaseUnits: string;
  capitalBaseUnits: string;
  totalDisplay: string;
  laborDisplay: string;
  capitalDisplay: string;
};

export type InvalidSettlementSplit = {
  status: "empty" | "invalid" | "unavailable";
  message: string;
};

export type SettlementSplit = ValidSettlementSplit | InvalidSettlementSplit;

function remainingEscrow(value: string | null | undefined, decimals: number): { baseUnits: bigint; display: string } | null {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255 || !value || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const baseUnits = BigInt(value);
  return { baseUnits, display: formatUnits(baseUnits, decimals) };
}

function validSplit(laborBaseUnits: bigint, total: { baseUnits: bigint; display: string }, decimals: number): SettlementSplit {
  if (laborBaseUnits > total.baseUnits) {
    return { status: "invalid", message: "Labor provider amount cannot exceed the remaining escrow." };
  }
  const capitalBaseUnits = total.baseUnits - laborBaseUnits;
  return {
    status: "valid",
    totalBaseUnits: total.baseUnits.toString(),
    laborBaseUnits: laborBaseUnits.toString(),
    capitalBaseUnits: capitalBaseUnits.toString(),
    totalDisplay: total.display,
    laborDisplay: formatUnits(laborBaseUnits, decimals),
    capitalDisplay: formatUnits(capitalBaseUnits, decimals)
  };
}

export function calculateSettlementSplit(draft: string, totalBaseUnits: string | null | undefined, decimals: number): SettlementSplit {
  const total = remainingEscrow(totalBaseUnits, decimals);
  if (!total) {
    return { status: "unavailable", message: "Remaining escrow is unavailable. Refresh canonical escrow state before proposing a split." };
  }
  const value = draft.trim();
  if (!value) {
    return { status: "empty", message: "Enter the labor provider amount to preview the exact split." };
  }
  const match = value.match(/^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/);
  if (!match) {
    return { status: "invalid", message: "Enter a plain token amount with no signs, commas, or exponent notation." };
  }
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    return { status: "invalid", message: `This token supports up to ${decimals} decimal places.` };
  }
  const scale = 10n ** BigInt(decimals);
  const fractionBaseUnits = BigInt(fraction.padEnd(decimals, "0") || "0");
  const laborBaseUnits = BigInt(match[1]) * scale + fractionBaseUnits;
  return validSplit(laborBaseUnits, total, decimals);
}

export function settlementSplitFromBaseUnits(laborBaseUnits: string | null | undefined, totalBaseUnits: string | null | undefined, decimals: number): SettlementSplit {
  const total = remainingEscrow(totalBaseUnits, decimals);
  if (!total) {
    return { status: "unavailable", message: "Remaining escrow is unavailable. Refresh canonical escrow state before using this proposal." };
  }
  if (!laborBaseUnits || !/^(0|[1-9][0-9]*)$/.test(laborBaseUnits)) {
    return { status: "invalid", message: "The current settlement proposal has an invalid labor-provider amount." };
  }
  return validSplit(BigInt(laborBaseUnits), total, decimals);
}
