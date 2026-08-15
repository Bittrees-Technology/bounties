/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ESCROW_ENABLED?: string;
  readonly VITE_ESCROW_CREATION_ENABLED?: string;
  readonly VITE_ESCROW_PRE_ACCEPTANCE_CANCELLATION_ENABLED?: string;
  readonly VITE_ESCROW_STAGED_MILESTONE_FUNDING_ENABLED?: string;
  readonly VITE_DEFAULT_CHAIN_ID?: string;
  readonly VITE_CHAIN_1_BOUNTY_ESCROW_ADDRESS?: string;
  readonly VITE_CHAIN_11155111_BOUNTY_ESCROW_ADDRESS?: string;
  readonly VITE_CHAIN_8453_BOUNTY_ESCROW_ADDRESS?: string;
  readonly VITE_CHAIN_84532_BOUNTY_ESCROW_ADDRESS?: string;
  readonly VITE_CHAIN_4663_BOUNTY_ESCROW_ADDRESS?: string;
  readonly VITE_CHAIN_46630_BOUNTY_ESCROW_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
