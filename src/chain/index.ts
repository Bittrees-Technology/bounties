export type {
  AssetConfig,
  ChainConfig,
  ChecksumAddress,
  CuratedTokenSymbol,
  EscrowClient,
  EscrowAction,
  EscrowContractName,
  EscrowDeliveryInput,
  EscrowEvent,
  EscrowEventType,
  EscrowFundingInput,
  EscrowOrderRef,
  EscrowSettlementInput,
  EscrowOnchainRecord,
  EscrowOnchainState,
  EscrowTokenRef,
  EscrowTxResult,
  EscrowTxState,
  SupportedAsset,
  SupportedChainId,
  TokenIdentity,
  TokenInspectionSnapshot,
  TokenInspectionWarning
} from "./types";

export { EscrowClientError, mapErrorToUserMessage, errorCodeOf } from "./errors";
export type { EscrowErrorCode } from "./errors";

export { mapEventTypeToLabel } from "./events";

export { BOUNTY_ESCROW_ABI, ESCROW_BOUNDARY_ABI } from "./abi";
export type { EscrowAbiEvent, EscrowAbiFunction, EscrowAbiParameter, EscrowBoundaryAbi } from "./abi";

export { activeChainId, assets, chains, CHAIN_INTEGRATION_ENABLED, curatedTokenSymbols, getAssetConfig, getChainConfig, getExplorerContractUrl } from "./config";

export {
  assertIntegrationEnabled,
  assertSupportedAsset,
  assertSupportedAssetOnNetwork,
  assertSupportedNetwork,
  assertValidAmount,
  assertValidBaseUnitAmount,
  assertTokenIdentityOnNetwork,
  checkEscrowReadiness,
  isSupportedAsset,
  isSupportedChain
} from "./guardrails";
export type { GuardrailCheck } from "./guardrails";

export {
  APPROVAL_DOMAIN,
  EVIDENCE_DOMAIN,
  HASH_CODEC_VERSION,
  SCOPE_DOMAIN,
  TERMS_DOMAIN,
  assertBytes32Hash,
  fromKnownBytes32Hash,
  hashApproval,
  hashEvidence,
  hashScope,
  hashSourceJson,
  hashTerms
} from "./hashCodec";
export type {
  ApprovalCommitmentInput,
  Bytes32Hex,
  CommitmentLabel,
  EvidenceCommitmentInput,
  ScopeCommitmentInput,
  TermsCommitmentInput,
  VersionedHash
} from "./hashCodec";

export { buildEscrowAdapterConfig, createDisabledLiveEscrowAdapter, createViemEscrowAdapter, selectEscrowProvider } from "./escrowAdapter";
export type {
  Eip1193Provider,
  EscrowAdapterConfig,
  EscrowProviderMode,
  EscrowProviderSelection,
  SelectedEscrowProvider,
  SmartWalletProvider,
  ViemEscrowAdapterOptions
} from "./escrowAdapter";

export {
  TOKEN_REGISTRY_INTERFACE_VERSION,
  curatedTokens,
  getConfiguredCuratedTokenIdentity,
  getCuratedTokenEntry,
  inspectTokenInput,
  isAddressFormat,
  isLikelyChecksummedAddress,
  validateTokenIdentity
} from "./tokenRegistry";
export type { CuratedTokenEntry, TokenValidationInput } from "./tokenRegistry";

export { useEscrowTransaction } from "./useEscrowTransaction";
export type { EscrowTransactionState } from "./useEscrowTransaction";
