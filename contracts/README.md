# Bounty Escrow Contracts (testnet review)

This is an original, minimal ERC20 escrow implementation prepared for deterministic
Foundry review. It is not a production deployment package and has not been broadcast.

## Lifecycle

`Created -> Funded -> Assigned -> Delivered -> Accepted -> Released`

Side paths:

- `Created|Funded -> Refunded` by the requester before assignment.
- `Assigned -> Refunded` by the requester once the optional deadline passes.
- `Assigned|Delivered -> Disputed -> Resolved` by an arbiter payout decision.

Every transition emits `BountyStateTransition` with the bounty, actor, parties,
escrow amount, and payout amounts. Creation emits `BountyCreated`.

## Authority model

- Requester: creates/funds, assigns, accepts, cancels before assignment, claims a
  configured timeout refund, and can dispute.
- Provider: delivers and can dispute after assignment.
- `ARBITER_ROLE`: resolves only disputed bounties and may release, refund, or split
  escrow. It cannot otherwise withdraw funds.
- `GUARDIAN_ROLE`: pauses/unpauses creation and funding only. Release, refund, and
  dispute resolution intentionally remain callable while paused.
- `DEFAULT_ADMIN_ROLE`: grants/revokes arbiter and guardian roles. Operational role
  custody and admin transfer procedures are deployment blockers for production.
- Release after acceptance is permissionless so an already-owed payout cannot be
  withheld by an unavailable requester.

One arbitrary ERC20 address is recorded per bounty. Native ETH is not supported.
Deposits use OpenZeppelin `SafeERC20` and actual received balance deltas. Rebasing
tokens remain unsupported because their balances can change independently of escrow
accounting.

## Reproducible local setup

Dependencies are intentionally excluded from the application repository and pinned
by tag in the install commands:

```sh
cd contracts
mkdir -p lib
git clone --depth 1 --branch v5.0.2 https://github.com/OpenZeppelin/openzeppelin-contracts.git lib/openzeppelin-contracts
git clone --depth 1 --branch v1.9.6 https://github.com/foundry-rs/forge-std.git lib/forge-std
forge build
forge test
```

The reviewed dependency commits are OpenZeppelin `dbb6104ce834628e473d2173bbc9d47f81a9eec3`
and forge-std `3b20d60d14b343ee4f908cb8079495c07f5e8981`.

Tests are offline and do not use RPC endpoints or forks.

## Deployment template (do not run in this review)

`script/Deploy.s.sol` reads `ADMIN_ADDRESS`, `ARBITER_ADDRESS`,
`GUARDIAN_ADDRESS`, and `TOKEN_ADDRESS`. The token is a review/deployment parameter
only because the escrow supports a different ERC20 for each bounty. A deployment
operator may later simulate the template, prepare the required preflight packet, and
only then decide whether to broadcast on an explicitly approved test network.

No private key is embedded or read by the script. No broadcast was performed during
this task.

## Stateful safety campaign

`test/fuzz/BountyEscrowInvariant.t.sol` exercises assignment, delivery, acceptance,
release, dispute, resolution, and cancellation sequences. It asserts escrow/token
conservation, zero terminal liability, and bounded payouts. See `PROPERTIES.md` for
the executable properties and remaining multi-bounty/token campaign gaps.

## Known review gaps / production blockers

- Independent security review and broader multi-bounty/stateful campaigns are still needed.
- Define multisig/timelock custody and rotation for admin, arbiter, and guardian roles.
- Establish maximum bounty sizes, approved-token policy, monitoring, and incident runbooks.
- Review fee-on-transfer and callback-capable tokens; rebasing tokens are unsupported.
- Decide provider protections and grace periods around requester timeout refunds.
- Decide whether disputes need evidence hashes, reason codes, or an appeal window.
- Deployment requires Base Sepolia addresses, gas estimation, simulation, and a saved
  preflight packet. Production or mainnet deployment is explicitly out of scope.
