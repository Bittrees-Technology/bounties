# ADR 0001: Production application architecture

- Status: Accepted for application implementation; contract binding remains pending
- Date: 2026-08-11
- Scope: Bounties application, excluding contract deployment and publication
- Baseline inspected: `codex/draft-bounties-independence-product` at `f6c7b75`

## Context and decisions

Bounties is a standalone, wallet-only marketplace. It must not depend on `claims.bittrees.org`, email identity, a privileged marketplace operator, demo state, or a dispute workflow. Any connected wallet can create a bounty, propose, accept a proposal when it owns the bounty, submit delivery when assigned, and accept delivery when it owns the bounty. “Permissionless” means no allowlist or administrator approval; it does not mean one wallet may mutate another wallet's records.

The application is split into four boundaries:

1. The browser owns wallet connection, message signing, responsive journeys, and reads/writes through the application API.
2. Server endpoints verify nonce signatures, issue and rotate sessions, validate business transitions, perform chain inspection, and use a narrowly scoped database connection. They never accept a caller wallet address as proof of identity.
3. Supabase Postgres is the source of truth for accounts, roles, bounty workflow data, token identities, escrow observations, and notifications. RLS is defense in depth and derives identity from a server-verified wallet claim.
4. A versioned escrow adapter is the only code allowed to know the deployed contract ABI, address, event signatures, or scope/evidence hash encoding. No deployment address is committed until operations supplies a reviewed chain configuration.

## Wallet authentication and sessions

Use a SIWE-compatible EIP-4361 message for EVM wallets. The server generates a cryptographically random, single-use nonce and persists only its digest in `auth_nonces` with `wallet_address`, `chain_id`, `domain`, `uri`, `issued_at`, `expires_at`, and `consumed_at`. A nonce is bound to the normalized EIP-55 address, expected origin, requested chain, and purpose (`sign-in`). It expires after five minutes and is consumed atomically. Rate-limit issuance and verification by wallet and network source.

The verification endpoint reconstructs the expected message; checks domain, URI, statement, version, chain ID, nonce, issued-at, expiration, and recovered signer; and rejects replay, expired, malformed, wrong-origin, wrong-chain, and wrong-signer messages. Contract wallets must be verified with ERC-1271 when supported; otherwise the UI states that only EOAs are supported until that path ships.

On success, the server upserts `wallet_accounts` and creates an opaque session. Store only a SHA-256 digest of the session token in `wallet_sessions`; return the token in a `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` cookie. Sessions have a short idle lifetime (recommended 30 minutes), an absolute lifetime (recommended 24 hours), rotation after authentication and privilege-sensitive actions, and explicit revocation. CSRF protection uses strict origin checks plus a session-bound CSRF token for mutations. Never put bearer tokens in local storage.

Every request resolves the cookie to a non-revoked session and injects verified claims into the database transaction (`app.wallet_address`, `app.session_id`, optionally a constrained Postgres role). The API ignores user-supplied owner/provider fields and writes actor columns from the verified session. Disconnecting a wallet does not silently revoke other sessions; sign-out revokes the current session. A connected wallet that differs from the session wallet triggers reauthentication. Expired sessions yield a stable `SESSION_EXPIRED` response and preserve unsent form state client-side.

## Persistence model

Use UUID primary keys for application records, `timestamptz` in UTC, append-only audit timestamps, and PostgreSQL enums or checked text for finite workflow states. Wallet addresses are stored as 20-byte values or canonical lowercase hex for uniqueness, with checksummed display derived at the edge. Monetary values are never JavaScript `number`: persist decimal strings as `numeric(78,0)` integer base units plus token decimals from the referenced token snapshot.

| Table | Required identity and purpose |
| --- | --- |
| `wallet_accounts` | unique wallet address; profile fields; status; created/last-seen timestamps |
| `account_roles` | account + role (`buyer`, `provider`); roles are self-selected capabilities, not authorization grants |
| `auth_nonces` | hashed, bound, expiring single-use challenges |
| `wallet_sessions` | hashed opaque token, wallet account, expiry, rotation/revocation metadata |
| `tokens` | unique `(chain_id, contract_address)`; checksum address, name, symbol, decimals, total supply if callable, bytecode hash/presence, proxy/source verification state, explorer URL, inspection time and risk flags |
| `bounties` | creator account, title/scope, immutable `scope_hash`, chain/token reference, budget base units, status, accepted proposal, timestamps |
| `bounty_support` | bounty attachments/URIs and content hashes; no executable remote content |
| `acceptance_criteria` | ordered, immutable-after-acceptance criteria tied to bounty or milestone |
| `proposals` | bounty, provider, proposed total base units, note, status; unique active proposal per provider/bounty |
| `milestones` | bounty, ordinal, exact base-unit amount, scope/evidence expectations, status; unique ordinal per bounty |
| `delivery_evidence` | milestone, provider, URI, content hash, immutable `evidence_hash`, submitted timestamp; append-only revisions |
| `escrow_records` | bounty, chain/token/address identity, contract binding version, onchain bounty ID, requested/received/released/refunded base units, tx hashes, confirmation/finality state |
| `escrow_events` | unique `(chain_id, tx_hash, log_index)`, block/hash, decoded adapter version, event payload; reorg-aware |
| `notifications` | recipient account, type, entity reference, read timestamp, dedupe key |

Foreign keys use restrictive deletion. Public workflow records are archived, not cascaded away. Auth challenges and expired sessions may be retention-purged. Delivery evidence and escrow event rows are append-only. Notification payloads contain entity IDs and safe display text, not secrets.

Milestones must sum exactly to the bounty budget in base units. Default splits allocate `quotient = total / count` and distribute the integer remainder deterministically across the first milestones; this fixes totals such as 250 without rounding loss. A proposal's proposed total must equal its proposed milestone sum. On acceptance, the server transaction locks the bounty and proposal, revalidates both sums and status, rejects token/decimal changes, and materializes the accepted milestone amounts. Database constraints and deferred constraint triggers enforce these invariants independently of the UI.

## Token registry and inspection

The curated display set is WETH, BTREE, BIT, WBTC, USDC, and USDT. ETH is presented as WETH because escrow is ERC20-only. Curated rows are still identified only by `(chain_id, contract_address)`; chain-specific addresses remain explicit configuration placeholders until verified, never symbol-only defaults.

Any authenticated wallet may request another ERC20 using chain ID plus an EIP-55 checksummed contract address. A server-side chain inspector must verify chain support, checksum, non-empty bytecode, `name`, `symbol`, `decimals`, and `totalSupply` where callable, recording call failures rather than inventing values. It records bytecode hash, EIP-1967 or other detected proxy indicators, implementation address where discoverable, and explorer source-verification status where the explorer API provides it. Cache with an inspection timestamp and permit reinspection.

Symbols and names are untrusted display data. The UI shows address and chain beside them, warns on symbol collisions, unknown/unverified source, proxy/upgradeability, failed metadata calls, unusual decimals, and missing/changed bytecode, and links directly to the configured block explorer's contract page. Token selection must pass the token row ID or chain/address pair, never a symbol.

## RLS and authorization

RLS is enabled and forced on every application table. Browser clients never receive the Supabase service-role key. The normal request path uses the authenticated database role with transaction-local verified claims; any service-role maintenance path is isolated, audited, and cannot be selected through a request parameter.

Policy helpers validate `current_setting('app.wallet_address', true)` as a canonical address and map it to one account. Reads are public only for open marketplace data intentionally exposed by a view. Private profile/session/auth data is self-only. Notifications are recipient-only. Tokens are readable by all; authenticated users may request inspection, but only the inspector function can finalize metadata fields.

Workflow mutation policies and server transition checks both enforce:

| Action | Allowed actor | Preconditions |
| --- | --- | --- |
| Create bounty | any authenticated wallet | valid token identity, exact positive base-unit budget and milestone sum |
| Edit/publish/cancel | bounty creator | only before proposal acceptance/funding as applicable |
| Propose/withdraw | any authenticated wallet except creator | bounty open; only own proposal |
| Accept proposal | bounty creator | bounty open; proposal active; exact budget reconciliation |
| Fund/reconcile escrow | creator initiates; indexer records | accepted proposal; adapter/chain/token match |
| Submit delivery | accepted provider | assigned/funded milestone; evidence hash and URI present |
| Accept delivery | bounty creator | delivered milestone |
| Release | anyone may relay if contract permits | accepted onchain state; no database-only claim of payment |
| Read notifications | recipient only | session account equals recipient |

There is no dispute, arbiter, claims, or sibling-product policy. Refund/cancellation behavior exposed by the application must match the final approved contract interface; until then it stays behind the escrow adapter and is not represented as available.

Negative authorization tests are release-blocking: anonymous mutation; forged wallet field; nonce replay; wrong signer/domain/chain/origin; expired/revoked session; creator proposing to own bounty; non-owner edit/accept; unassigned provider delivery; cross-account evidence modification; cross-account notification/session read; direct token metadata finalization; invalid state transition; service-role key absence from built assets; and RLS behavior when claims are missing or malformed.

## Contract, ABI, event, and hash boundary

The current `contracts/src/BountyEscrow.sol` and `src/chain/abi.ts` are not the production application contract. They contain dispute/arbiter behavior that is expressly out of product scope, and the TypeScript descriptor does not match the Solidity ABI. Preserve them as historical/testnet inputs until the parallel contract stream lands; do not deploy or broadcast them.

Create a replaceable `EscrowAdapter` with:

- a checked-in canonical JSON ABI and generated TypeScript types tied to an `interfaceVersion` and artifact hash;
- chain configuration keyed by chain ID with contract address, deployment block, required confirmations, explorer base URL, and enabled flag;
- commands for create/fund, assign accepted provider, record delivery hash, accept, release, and approved timeout/cancel paths only;
- event decoding into versioned domain events using `(chain_id, tx_hash, log_index)` identity, block-hash confirmation, and reorg rollback;
- read-before-write guards that compare wallet, token, exact amount, provider, and current state;
- no UI import of raw ABI, event topic, deployed address, or contract enum ordinal.

The parallel contract stream owns the exact Solidity function/event names, state machine, custom errors, and immutable hash encoding. Integration must supply a golden-vector document with canonical field order, types, normalization, byte encoding, and hash algorithm for `scope_hash` and `evidence_hash`, plus vectors reproduced in Solidity and TypeScript. Until those vectors merge, the application stores versioned 32-byte hash values produced by a single `hashCodec` module and must not guess an encoding. Raw source JSON is persisted separately for audit; changing source content creates a new revision rather than mutating an accepted hash.

An escrow record is an observation, not custody: database status never causes or proves transfer. Funding becomes effective only after the adapter observes the canonical contract event at the configured finality and reconciles chain ID, contract, bounty ID, creator, token, and actual received base units. Fee-on-transfer or rebasing behavior must be rejected or explicitly supported by the final contract and UI; requested and received amounts are kept separately.

## API and transaction boundary

Use server endpoints (or Supabase Edge Functions with equivalent controls) for nonce issue/verify, every workflow transition, token inspection, and chain reconciliation. Direct client writes are limited to carefully reviewed RLS-safe operations; the preferred production path is server-mediated to keep validation and audit behavior consistent. Each mutation accepts an idempotency key, validates a schema, opens one database transaction, derives actor identity, locks the current aggregate, applies a legal transition, inserts notifications with dedupe keys, and returns the new representation.

Outbox rows should drive asynchronous chain indexing and notification delivery. Retries are idempotent. Logs include request/session correlation IDs and entity IDs, but never signatures, cookies, raw nonces, or private support content.

## Implementation sequence and acceptance

1. Add local Supabase configuration, migrations, RLS helpers/policies, generated database types, and seed only deterministic test fixtures outside production migrations.
2. Implement nonce/session endpoints and negative authentication tests.
3. Replace in-memory `seedOrders`/`marketplaceServices` with repositories and persistent flows; remove demo metrics and controls.
4. Implement token inspection/registry and risk presentation.
5. Add the escrow adapter with a disabled deployment configuration; merge the contract artifact/hash vectors later without changing domain repositories or UI flows.
6. Validate migrations on a clean database, RLS as anonymous and two distinct wallets, exact-unit property tests, API integration tests, frontend E2E, accessibility/responsive behavior, and clean console/network output.

Production enablement requires resolved dependency audit, lint, build, unit/integration/E2E suites, verified security headers, and operations-provided contract configuration after the contract stream and final review. This ADR authorizes no deployment, main-branch publication, or contract broadcast.

## Risks and open integration inputs

- The parallel contract ABI and immutable hash golden vectors are not yet available; the adapter must remain disabled and versioned until they are reviewed.
- The existing escrow contract includes disputes and roles that conflict with this product decision; application code must not normalize that mismatch into a live flow.
- Supabase's service-role bypasses RLS. Accidental browser exposure is catastrophic; test bundles and environment boundaries explicitly.
- ERC-1271 and chain RPC/explorer behavior vary. Define supported chains and failure modes before claiming universal wallet or verification support.
- Token metadata, verified source, and proxy detection are advisory, not proof of safety. Preserve inspection evidence and show warnings.
- Finality and reorg handling can temporarily reverse observed funding state; UX must distinguish submitted, confirmed, and finalized.

## Inspection evidence

The baseline was inspected before this ADR was written with:

```text
git status --short --branch
git log -5 --oneline --decorate
rg --files -g 'AGENTS.md' -g '!node_modules' -g '!dist'
rg --files
sed -n '1,260p' docs/independence-product-draft.md
sed -n '1,260p' src/chain/abi.ts
sed -n '1,260p' src/chain/events.ts
sed -n '1,260p' contracts/src/BountyEscrow.sol
sed -n '1,220p' src/types.ts
sed -n '1,220p' src/bountyModel.ts
cat package.json
```

At inspection, the working tree was clean on `codex/draft-bounties-independence-product`; HEAD was `f6c7b75 fix: refresh audited transitive dependencies`, preceded by `af60ca7 Draft standalone Bounties product boundary`, with `main` at `1b29d84`. This ADR is additive and does not alter those commits or unrelated source files.
