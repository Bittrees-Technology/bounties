# Bounty escrow contracts

`BountyEscrow` is a permissionless, ERC20-only sequential milestone escrow. A bounty is a record and
never an NFT. The contract has no owner, administrator, arbiter, token allowlist,
cap, pause, dispute, or claims flow.

Each requester/terms commitment is a one-time creation key. Both single and
milestone creation record `bountyIdByRequesterAndTermsHash`; a replay of the
same committed terms reverts with `DuplicateBounty` before any ERC20 transfer.
The reservation remains after cancellation or settlement, so an intentional
replacement must use a freshly salted scope commitment.

The deterministic Ethereum Sepolia, Base Sepolia, and Robinhood Chain Testnet
deployments, Safe authority, transaction receipts, bytecode hashes, and source
verification records are published in [`deployments/testnet-v2.json`](deployments/testnet-v2.json).
These replacement testnet deployments include the one-time creation-key
invariant and do not authorize a mainnet deployment. The predecessor deployment
is retired with zero BIT balance and liability. It remains recorded in
[`deployments/testnet.json`](deployments/testnet.json) as incident evidence and
is not a configured application target.

Native ETH is not accepted. Product surfaces that say ETH must pass a WETH ERC20
address. Token symbols, decimals, names, and offchain prices are never read.

## Lifecycle

```text
Created -> Funded -> ProviderAccepted -> Delivered -> BuyerApproved -> Released
    |          |              ^      |       |
    +----------+-> Cancelled  |      |       +-> Released (at/after reviewDeadline)
               |              +-- Revision (once, seven days to resubmit)
               +-------------> Refunded (missed active delivery/revision deadline)
               \__________________________________-> Settled (bilateral exact split)
```

## Milestone schedule

- A creator may use the single-deliverable `createBounty` compatibility path or
  `createMilestoneBounty` with 1–32 ordered deliverables.
- Every milestone allocation is a positive token base-unit amount. Their exact
  sum is stored as `allocatedAmount`, and funding must equal that sum. Partial
  funding and unallocated principal are rejected.
- Each milestone carries a required, positive, absolute `uint64` Unix delivery
  deadline. Consecutive deadlines must be more than 21 days apart so a full
  original review, revision period, and revised review cannot consume the next
  milestone's delivery window.
- Only `currentMilestone` can be submitted. Its evidence opens its own seven-day
  review. Buyer approval or review expiry lets anyone release exactly that
  milestone allocation to the provider. A nonfinal release advances the active
  index and active `Bounty.deliveryDeadline`; the final release terminates the bounty.
- During that review, the requester may record one nonzero revision-reason hash
  for the active milestone. This returns it to pending and gives the provider a
  fixed seven days to resubmit. A second revision is impossible. Missing the
  revision deadline lets the requester refund all unreleased principal; a revised
  submission must use a different evidence commitment and opens the normal
  seven-day approval or permissionless-release window.
- The schedule hash commits exact ordered amounts and deadlines. Milestone terms
  bind that schedule to the provider and proposal, preventing substitution after
  provider acceptance.
  `scheduleHash = keccak256(abi.encode(MILESTONE_SCHEDULE_DOMAIN, chainId,
  escrowAddress, scopeHash, milestoneAmounts, milestoneDeadlines))`, and
  `termsHash = keccak256(abi.encode(MILESTONE_TERMS_DOMAIN, chainId,
  escrowAddress, scopeHash, proposalHash, provider, scheduleHash))`.
- A requester may cancel a `Created` or `Funded` record before the committed
  provider accepts onchain. Cancelling a funded record returns the exact
  outstanding principal to the requester. Once the provider accepts, unilateral
  cancellation is unavailable. If the provider misses the active milestone
  deadline, anyone may trigger the deterministic refund of all unreleased
  principal to the requester. Bilateral settlement likewise splits only
  unreleased principal; completed milestone payments remain final.
- Settlement offers last at most `SETTLEMENT_PROPOSAL_PERIOD` (seven days) and
  are shortened to the active delivery or review deadline. Acceptance is invalid
  at the exact expiry boundary. The current proposer may cancel without changing
  the bounty lifecycle, and offers are cleared whenever provider acceptance,
  milestone delivery, buyer approval, release, cancellation, refund, settlement,
  or milestone advancement changes the lifecycle context.

### Frontend and persistence contract

Creation collects each line as `title | amount | delivery date`. Titles and
descriptions remain offchain; the adapter sends ordered `amountBaseUnits[]` and
absolute `deliveryDeadline[]` values. Persistence stores immutable schedule
snapshots with `position`, `title`, `amount_base_units`, and `delivery_deadline`,
orders by `position`, and rejects a total different from bounty funding. Token
decimals are display metadata; persisted and contract amounts are integer base units.

The client reads `getBounty` for allocation totals, released totals, and active
index, then `getMilestone(bountyId, index)` for each deliverable's amount,
delivery/review deadlines, state, evidence, and approval commitments. Legacy
top-level evidence/deadline fields mirror the active milestone.

- Anyone can create a record.
- The requester alone funds it, approves delivery, and cancels before provider
  acceptance. A funded cancellation refunds the exact outstanding principal.
  A deterministic timeout refund may be triggered by anyone, but it always pays
  the requester.
- The requester commits the provider and proposal hash at creation time. The
  stored terms hash is
  `keccak256(abi.encode(TERMS_DOMAIN, chainId, escrowAddress, scopeHash, proposalHash, provider))`.
- Only that committed provider can accept the exact committed terms.
- Only that provider can submit the immutable evidence commitment. Its canonical offchain
  preimage contains both the URI hash and the provider-supplied SHA-256 digest of the exact
  delivered file or documented canonical bundle bytes. The URI is never used as a substitute
  for delivered content, and direct contract callers are responsible for deriving the same
  canonical commitment before calling `submitDelivery`.
- Delivery stores `reviewDeadline = block.timestamp + 7 days`. Anyone can
  trigger full release after buyer approval or at/after that exact deadline;
  payout always goes to the recorded provider.
- Before that review deadline, the requester may call `requestRevision` exactly
  once for the active milestone with a nonzero reason hash. The provider then has
  `REVISION_PERIOD` (seven days) to replace the evidence commitment. The hash and
  deadline remain in the milestone record as an audit trail.
- In `Funded`, `ProviderAccepted`, `Delivered`, or `BuyerApproved`, either requester or provider
  may propose an exact provider payout from zero through the full principal.
  Only the counterparty can accept the current exact, unexpired proposal. Every
  offer expires within seven days and cannot outlive the active delivery or
  review window; the current proposer may cancel it. Acceptance terminally pays
  that amount to the provider and refunds the entire remainder to the requester
  in one atomic transaction.
- Creation rejects zero delivery deadlines. Acceptance and delivery require
  `block.timestamp < deliveryDeadline`; a `Funded` or `ProviderAccepted` refund
  requires `block.timestamp >= deliveryDeadline`.
- There is no adjudication or dispute dependency. The seven-day review expiry
  deterministically releases the full principal; a different split requires
  bilateral requester/provider consent.

Terminal transfers follow checks-effects-interactions, zero principal and reduce
per-token liability before external calls, and are guarded against reentrancy.
For bilateral settlement, both exact transfers revert atomically if either leg
fails, and provider payout plus requester refund always equals the principal.
Funding and payout both verify exact contract/recipient balance deltas. This
rejects false-returning, fee-on-transfer, sender-taxed, and other inexact behavior
when observed. Rebasing and adversarial tokens are unsupported: a later negative
rebase cannot be prevented and causes solvency/settlement checks to fail closed.
Direct token transfers are not credited to any bounty.

Commitment domains and canonical `abi.encode` field order are documented in
[`src/BountyEscrow.sol`](src/BountyEscrow.sol). The stable Solidity surface,
including enum order, events, and custom errors, is
[`src/IBountyEscrow.sol`](src/IBountyEscrow.sol).

## Reproducible local setup

The package pins Solidity to `0.8.24` in `foundry.toml` and uses these audited
dependency commits:

- OpenZeppelin Contracts v5.0.2:
  `dbb6104ce834628e473d2173bbc9d47f81a9eec3`
- forge-std v1.9.6:
  `3b20d60d14b343ee4f908cb8079495c07f5e8981`

Install the exact commits (the ignored `lib/` directory is local-only):

```sh
cd contracts
git clone --no-checkout https://github.com/OpenZeppelin/openzeppelin-contracts.git lib/openzeppelin-contracts
git -C lib/openzeppelin-contracts checkout dbb6104ce834628e473d2173bbc9d47f81a9eec3
git clone --no-checkout https://github.com/foundry-rs/forge-std.git lib/forge-std
git -C lib/forge-std checkout 3b20d60d14b343ee4f908cb8079495c07f5e8981
forge fmt --check
forge build
forge test
```

No RPC endpoint, signer, fork, deployment, or broadcast is required. The script
package contains only a local construction/simulation template and no broadcast
instruction.
