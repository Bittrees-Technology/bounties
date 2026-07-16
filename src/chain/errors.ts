export type EscrowErrorCode =
  | "NETWORK_UNSUPPORTED"
  | "ASSET_UNSUPPORTED"
  | "AMOUNT_INVALID"
  | "INTEGRATION_DISABLED"
  | "WALLET_NOT_CONNECTED"
  | "INSUFFICIENT_ALLOWANCE"
  | "CONTRACT_REVERTED"
  | "USER_REJECTED"
  | "UNKNOWN";

export class EscrowClientError extends Error {
  readonly code: EscrowErrorCode;

  constructor(code: EscrowErrorCode, message: string) {
    super(message);
    this.name = "EscrowClientError";
    this.code = code;
  }
}

const USER_MESSAGES: Record<EscrowErrorCode, string> = {
  NETWORK_UNSUPPORTED: "This action needs a supported Bittrees escrow network. Switch networks and try again.",
  ASSET_UNSUPPORTED: "This asset is not supported for escrow yet. USDC is the only supported settlement asset.",
  AMOUNT_INVALID: "Enter a valid positive escrow amount.",
  INTEGRATION_DISABLED: "Live escrow settlement is disabled until legal, security, and onchain launch gates pass.",
  WALLET_NOT_CONNECTED: "Connect a wallet to continue. No wallet is required for this preview.",
  INSUFFICIENT_ALLOWANCE: "Spending approval is required before funds can move.",
  CONTRACT_REVERTED: "The escrow contract rejected this action.",
  USER_REJECTED: "The request was cancelled.",
  UNKNOWN: "Something went wrong with this escrow action."
};

export function mapErrorToUserMessage(error: unknown): string {
  if (error instanceof EscrowClientError) return USER_MESSAGES[error.code];
  return USER_MESSAGES.UNKNOWN;
}

export function errorCodeOf(error: unknown): EscrowErrorCode {
  return error instanceof EscrowClientError ? error.code : "UNKNOWN";
}
