# Local Supabase Setup

This project is wallet-first. Do not enable email/password login or commit service-role keys, private keys, RPC secrets, wallet mnemonics, production Supabase URLs, or production anon keys.

## Prerequisites

- Node.js matching the project runtime.
- Docker Desktop or another local Docker engine.
- Supabase CLI installed locally.

## Safe Local Boot

1. Copy `.env.example` to `.env.local`.
2. Start Supabase:

   ```bash
   supabase start
   ```

3. Copy `.env.local.example` to `.env.local` and set `SUPABASE_FUNCTIONS_ORIGIN` for the same-origin proxy. Do not add a Supabase anon key to frontend configuration; the browser uses wallet session cookies against `wallet-auth` and `bounties-api`.
4. Run migrations:

   ```bash
   supabase db reset
   ```

5. Start the app:

   ```bash
   npm run dev
   ```

## Migration Rules

- Create migrations with `supabase migration new <name>` from this repository root.
- Every table that stores account, role, bounty, proposal, milestone, delivery evidence, token registry, notification, nonce, or session data must enable RLS before it is used by the app.
- Wallet accounts are keyed by wallet address and chain-aware identities. Email login is out of scope.
- Wallet sessions must be nonce + signed-message based. Nonces must be single-use and expire.
- Add negative authorization tests with each RLS migration. At minimum, test anonymous access, the wrong wallet, the wrong role, and cross-account reads/writes.
- Bounty funding is persisted as ERC20 escrow records. ETH must be modeled as WETH in ERC20-only flows.
- Token identity is `(chain_id, checksummed_contract_address)`. Symbols are display-only and must never be trusted as identity.

## Token Registry Checks

When anyone adds an ERC20 token, inspect and persist:

- Chain ID and checksummed contract address.
- Bytecode presence at the address.
- Name, symbol, decimals, and total supply when callable.
- Proxy and source verification status when the block explorer exposes it.
- Collision and risk warnings when symbols or names overlap an existing token.
- A direct block-explorer contract link.

Curated placeholders are WETH, BTREE, BIT, WBTC, USDC, and USDT. Keep unknown chain-specific addresses blank until verified.
