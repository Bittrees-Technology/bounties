# Bounty escrow safety properties

The stateful Foundry campaign targets the smallest realistic risk boundary: one funded bounty, its requester, provider, arbiter, and ERC20 liability.

## Executable invariants

1. The escrow contract's token balance always equals the bounty's recorded liability.
2. Released, refunded, and resolved bounties always have zero remaining liability.
3. Combined requester/provider payouts never exceed the original funded amount.

## Deterministic lifecycle properties

- Only the requester can fund, assign, accept, cancel, or claim a timeout refund.
- Only the assigned provider can mark delivery.
- Only a requester or provider can raise a dispute.
- Only the arbiter can resolve a dispute.
- Accepted funds release once; terminal states cannot be paid twice.
- Pausing blocks new liabilities but cannot strand valid release, refund, or resolution paths.
- Reentrant token callbacks cannot create or fund a bounty twice.

## Remaining campaign gaps

- Multi-bounty and multi-token aggregate conservation.
- Fee-on-transfer token behavior beyond received-balance accounting.
- Malicious ERC20 return values and callback variants.
- Time-dependent abandoned-work and dispute-griefing sequences.
- Governance role rotation and revocation sequences.

These gaps must be covered before production deployment; this campaign is a testnet-review baseline, not an external audit substitute.
