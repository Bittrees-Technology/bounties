# Escrow production readiness

Status: **the current source restores funded cancellation before provider
acceptance and adds opt-in sequential milestone funding. Exact-match v3
deployments now exist on all three supported test networks and mainnets. Mainnet
application activation remains fail-closed; lifecycle soak, independent audit,
and the separate production release decision remain NO-GO gates**.

The repository includes an original Foundry escrow implementation, deterministic and stateful invariant tests, a fail-closed wallet adapter, wallet-only persistence, and server-verified escrow observations. None of this constitutes an audit, legal approval, deployment authorization, or custody approval.

## Proposed v1 boundary

- Full upfront ERC20 funding remains the default. A multi-milestone bounty may
  instead fund an exact sequential milestone prefix and add exact later tranches.
  Arbitrary partial amounts, overlaps, and double funding revert. ETH is
  represented by WETH. Fee-on-transfer, false-return, sender-taxed, and rebasing
  behavior fail closed on every tranche.
- A requester/terms commitment may create exactly one onchain bounty. Replays
  revert before token movement, and replacements require a fresh scope salt.
- Lifecycle: create with mandatory delivery deadlines, fund, provider accept,
  deliver, then immediate full release after buyer approval or permissionless
  release after a stored seven-day review deadline. During review, the requester
  may request one revision per milestone; the provider has a fixed seven days to
  submit a different evidence commitment, after which the unreleased principal is
  refundable if no delivery was made. Anyone may trigger that deterministic refund,
  but it always pays the requester. Consecutive milestone dates are more than 21 days apart.
- In funded, provider-accepted, delivered, or buyer-approved states, either party
  may propose an exact provider payout. The offer expires within seven days and
  no later than the active delivery or review boundary; the proposer may cancel,
  and only the counterparty may accept an unexpired offer. Acceptance atomically
  pays the provider and refunds the full remainder to the requester.
- The requester may cancel in `Created` or `Funded`; funded principal is returned
  exactly. Cancellation is unavailable after the provider accepts onchain.
- After a nonfinal release, a staged bounty pauses in `AwaitingFunding` if the
  next milestone was not prefunded. Work cannot be submitted until the requester
  deposits the next exact allocation. If that committed milestone deadline
  passes unfunded, anyone may close the record as `PartiallyCompleted`; released
  payments remain final, no unfunded amount is charged, and the terminal record
  counts as completed participant activity for directional reviews.
- The selected provider controls acceptance and delivery; only the requester can approve delivery.
- No arbiter, pause role, allowlist, marketplace administrator, or dispute path exists in Bounties.
- WETH, BTREE, BIT, WBTC, USDC, and USDT are curated labels, but identity is always chain ID plus inspected contract address. Any ERC20 may be added through the same inspection boundary.
- Claims or disputes belong to a future independent `claims.bittrees.org` product and cannot gain authority over this escrow by implication.

## Required launch sequence

1. **Specification freeze** — approve each chain, mandatory deadline behavior, the one-revision/seven-day resubmission rule, the seven-day delivery-review policy, settlement proposal expiry/cancellation wording, token presentation, milestone accounting, and the canonical evidence rule that independently binds the URI and provider-supplied SHA-256 digest of the exact delivered bytes.
2. **Contract hardening** — maintain multi-bounty/token conservation, malicious-token, revision, settlement, and exact deadline-boundary campaigns; run Slither and gas snapshots; resolve all high/medium findings.
3. **Independent audit** — commission an external auditor after the specification freeze; publish the report and fixes; rerun the full suite against the audited commit.
4. **Deployment authority** — use the operations-controlled deployment process, verify source and bytecode, document the deployer, and confirm the deployer receives no runtime authority over user records or escrow outcomes.
5. **Legal/compliance approval** — publish escrow terms covering custody characterization, buyer/provider IP, refunds, sanctions/AML posture, tax/reporting, contributor classification, jurisdiction, and privacy.
6. **Three-testnet-v3 replacement and soak** — the replacement `BountyEscrow`
   artifact with the one-time creation-key invariant is deployed, bytecode-matched,
   and source-verified on Ethereum Sepolia, Base Sepolia, and Robinhood Chain
   Testnet. Before setting `VITE_ESCROW_CREATION_ENABLED=true` or
   `VITE_ESCROW_PRE_ACCEPTANCE_CANCELLATION_ENABLED=true`, exercise
   every lifecycle branch, reconcile events against token balances, and run
   monitoring for at least one complete original-delivery and revised-delivery
   cycle on each network. Include both revision resubmission, missed-revision
   refund, staged next-milestone funding, duplicate-tranche rejection, and
   unfunded partial closure. `VITE_ESCROW_STAGED_MILESTONE_FUNDING_ENABLED=true`
   now targets only the exact-match v3 address; this enables testnet rehearsal,
   not mainnet or production-value approval.
7. **Operations readiness** — alert on unexpected balances, failed transactions, receipt-reconciliation failures, and application rollback conditions; rehearse incident response and frontend rollback.
8. **Production canary** — operator-approved application activation of the
   validated deployment, with clearly published risk limits and a documented
   observation period before widening use.

The immutable receipts, exact-match verification jobs, Safe address,
deterministic salt, and bytecode hashes for the current v3 release are in
[`contracts/deployments/testnet-v3.json`](../contracts/deployments/testnet-v3.json).
The separately deployed and validated mainnet records are in
[`contracts/deployments/mainnet-v3.json`](../contracts/deployments/mainnet-v3.json).
The preceding v2 release remains in
[`contracts/deployments/testnet-v2.json`](../contracts/deployments/testnet-v2.json)
and is retired from application configuration. Existing escrow records always
remain bound to their persisted contract address. The original deployment remains
in [`contracts/deployments/testnet.json`](../contracts/deployments/testnet.json)
as retired incident evidence with zero BIT balance and liability. The mainnet
contract addresses are not yet set in the application environment and mainnet
escrow actions remain disabled.

## Operator decisions still required

- Per-network launch approval for Ethereum (1/11155111), Base (8453/84532), and
  Robinhood Chain (4663/46630); a successful testnet soak does not approve mainnet.
- Verified chain-specific addresses for every curated token displayed by default; BTREE and BIT remain disabled until supplied.
- Operational presentation of mandatory delivery deadlines, the single seven-day
  revision window, the fixed seven-day review deadline, and expiring/cancellable
  bilateral settlement proposals.
- Replacement of every mainnet `CHAIN_*_RPC_URL` placeholder with an approved
  provider URL before a mainnet transaction. The three production-environment
  testnet RPC variables have been populated and their chain IDs verified.
- Contracting entity, custody/MSB/VASP assessment, IP/NDA owner, sanctions/AML controls, and payout tax/reporting entity.
- External auditor, bug-bounty budget, RPC/indexing providers, monitoring owner, and deployment gas budget.

## Go-live evidence packet

The production decision must reference one immutable release commit and contain:

- passing frontend and Foundry outputs, invariant configuration, static-analysis reports, and independent audit;
- verified contract address, source, bytecode hash, and chain/token IDs;
- testnet receipts for create/fund/provider-accept/deliver/revision-request/revised-delivery/buyer-approve/review-expiry release/bilateral settlement/cancel/original-timeout refund/revision-timeout refund and exact-accounting checks;
- signed legal, security, onchain, and operations GO/NO-GO decisions;
- monitoring dashboards, alert tests, incident contacts, rollback instructions, and canary caps.

No private key, mnemonic, RPC secret, or funded deployment command belongs in this repository.

## Vercel RPC configuration placeholders

The Vercel project may contain nonfunctional reserved-domain placeholders so the
required variable names are visible without storing credentials. Before any
testnet exercise, operations must replace the applicable value and verify the
remote chain ID. Mainnet values may remain placeholders until their separate GO:

- `CHAIN_1_RPC_URL` — Ethereum Mainnet
- `CHAIN_11155111_RPC_URL` — Ethereum Sepolia
- `CHAIN_8453_RPC_URL` — Base Mainnet
- `CHAIN_84532_RPC_URL` — Base Sepolia
- `CHAIN_4663_RPC_URL` — Robinhood Chain Mainnet
- `CHAIN_46630_RPC_URL` — Robinhood Chain Testnet

An RPC URL authorizes reads only in this application. It does not supply a signer,
private key, deployment authority, or permission to broadcast.
