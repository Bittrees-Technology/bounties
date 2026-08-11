export type HexAddress = `0x${string}`;
export type Bytes32Hex = `0x${string}`;

export interface ExpectedEscrowObservation {
  chainId: number;
  contractAddress: HexAddress;
  tokenAddress: HexAddress;
  requesterAddress: HexAddress;
  providerAddress: HexAddress;
  proposalHash: Bytes32Hex;
  amountBaseUnits: string;
}

export interface ReceiptEscrowObservation {
  chainId: number;
  contractAddress: HexAddress;
  tokenAddress: HexAddress;
  requesterAddress: HexAddress;
  providerAddress: HexAddress;
  proposalHash: Bytes32Hex;
  amountBaseUnits: string;
  txHash: string;
  receiptStatus: "success" | "failed";
}

export class EscrowObservationError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "EscrowObservationError";
  }
}

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function verifyCanonicalEscrowObservation(
  expected: ExpectedEscrowObservation,
  observed: ReceiptEscrowObservation,
  seenTransactionHashes: ReadonlySet<string> = new Set()
): ReceiptEscrowObservation {
  if (observed.receiptStatus !== "success") throw new EscrowObservationError("ESCROW_TX_NOT_SUCCESSFUL");
  if (seenTransactionHashes.has(observed.txHash.toLowerCase())) throw new EscrowObservationError("ESCROW_TX_REPLAYED");
  if (observed.chainId !== expected.chainId) throw new EscrowObservationError("ESCROW_CHAIN_MISMATCH");
  if (!sameHex(observed.contractAddress, expected.contractAddress)) throw new EscrowObservationError("ESCROW_CONTRACT_MISMATCH");
  if (!sameHex(observed.tokenAddress, expected.tokenAddress)) throw new EscrowObservationError("ESCROW_TOKEN_MISMATCH");
  if (!sameHex(observed.requesterAddress, expected.requesterAddress)) throw new EscrowObservationError("ESCROW_BUYER_MISMATCH");
  if (!sameHex(observed.providerAddress, expected.providerAddress)) throw new EscrowObservationError("ESCROW_PROVIDER_MISMATCH");
  if (!sameHex(observed.proposalHash, expected.proposalHash)) throw new EscrowObservationError("ESCROW_PROPOSAL_MISMATCH");
  if (observed.amountBaseUnits !== expected.amountBaseUnits) throw new EscrowObservationError("ESCROW_AMOUNT_MISMATCH");
  return observed;
}
