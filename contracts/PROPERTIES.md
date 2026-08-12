# Bounty escrow safety properties

The stateful Foundry campaign targets the smallest realistic risk boundary: one funded bounty, its requester, committed provider, and ERC20 liability.

## Executable invariants

1. The escrow contract's token balance is always at least its recorded liability; unsolicited surplus remains inert.
2. Released, refunded, cancelled, and bilaterally settled bounties always have zero remaining liability.
3. Combined requester/provider payouts never exceed the original funded amount.
4. `releasedAmount + outstanding amount` equals the exact allocation total until
   a refund or bilateral settlement terminates the outstanding balance.
5. Every milestone before `currentMilestone` is released, every later milestone
   is pending, and only the current milestone can progress.

## Deterministic lifecycle properties

- Only the requester can fund, cancel, or claim a timeout refund.
- The requester commits the provider at creation time, and only that provider can accept and mark delivery.
- Delivered funds cannot release before the stored seven-day review deadline
  without buyer approval, and anyone may release at the exact deadline.
- Either party may propose an exact bilateral split; only the counterparty can
  accept the current amount, and provider payout plus requester refund equals principal.
- Accepted or settled funds release once; terminal states cannot be paid twice.
- Reentrant token callbacks cannot create or fund a bounty twice.
- Milestone allocations are positive, ordered, and sum exactly to funding.
- Each milestone has its own seven-day review and releases exactly one tranche.
- Settlement and timeout refund apply only to outstanding principal after any
  completed tranche releases.
- Settlement proposals are invalidated on provider acceptance, delivery, buyer
  approval, and milestone advancement.

The stateful handler now exercises multiple bounties across two tokens, direct
transfers, deadlines, review expiry, cancellation, refund, approval, full release,
bilateral proposal replacement, and settlement. Deterministic
regressions also cover false-returning tokens, transfer fees, negative rebases,
reentrant callbacks, and smart-contract providers.
The milestone campaign additionally covers sequential delivery, buyer approval,
review-expiry release, partial release followed by settlement or timeout refund,
ordered state, exact allocation conservation, and token-value conservation.

The checked-in invariant profile runs 64 deterministic sequences of 128 calls
per invariant. Storage-dictionary collection is disabled because the handler
already exposes the bounded state space and explicit actors; this keeps the
campaign reproducible without weakening the exercised transition set.

## Remaining review boundaries

- Upgradeable or otherwise mutable token contracts can change behavior after
  inspection, so every value-bearing interaction must continue to fail closed.
- Campaigns cannot prove safety for every adversarial ERC20 implementation or
  replace an independent audit and operator-selected testnet rehearsal.

These boundaries must be resolved before production deployment; this campaign
is a testnet-review baseline, not an external audit substitute.
