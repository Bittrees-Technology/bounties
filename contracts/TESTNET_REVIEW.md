# Multi-network testnet review packet

Status: testnet-v3 deployed through the 1-of-1 operations Safe, runtime bytecode
matched locally, and source verified with exact matches on all three testnets.
Mainnet remains unauthorized.

## Intended review configuration

- Networks: Ethereum Sepolia (11155111), Base Sepolia (84532), and Robinhood
  Chain Testnet (46630).
- Sender: operations Safe `0x594f3B031992C2d6855383b3755653D6Fde35F01`,
  with its 1-of-1 owner approving each testnet transaction.
- Target: deterministic `BountyEscrow` address
  `0x45b64083d97947D5872464d8C1b6045f83D0193e` on all three networks.
- Constructor: none; the contract creates no administrator or privileged role.
- Review token: `TOKEN_ADDRESS`; not transferred or approved by this task.
- Value: 0 native ETH in constructor and all v1 bounty operations.
- Calldata/gas/simulation: Safe/CreateCall CREATE2 calldata generated from the
  pinned Foundry artifact and simulated before each broadcast.
- Expected state change: deployment only; no escrow record, token approval, or
  token transfer was included.
- Abort conditions: bytecode mismatch, unsupported chain ID, failed simulation, unexpected
  token behavior, missing validator approval, or any funded/mainnet intent.
- Monitoring: deployment receipt, bytecode verification, bounty transition events,
  finality/reorg signals, and escrow/token balance reconciliation.

## Verification evidence

Foundry: `forge 1.7.1` (`4072e48705af9d93e3c0f6e29e93b5e9a40caed8`).

The release gate reruns `forge fmt --check`, `forge build`, and `forge test` from
the contract package rather than relying on checked-in generated logs. The
deployment artifact passed 71 tests, including milestone unit, fuzz, and stateful
invariant suites, immediately before deployment.

Timestamp comparisons cover both boundaries: timeout refund is available at
`deliveryDeadline`, while permissionless full release is available at the stored
`reviewDeadline = delivery timestamp + 7 days`. Deadlines should use operationally
meaningful margins rather than exact block-second assumptions. The suite also
exercises requester/provider settlement proposals, the fixed seven-day maximum
expiry, shortening at delivery/review boundaries, proposer-only cancellation,
counterparty-only acceptance of unexpired offers, exact split conservation, and
atomic failure/reentrancy behavior.

Milestone review must reconcile every emitted `MilestoneConfigured` allocation
and deadline against the offchain schedule, prove their sum equals funding, then
exercise at least two sequential tranche releases, one review-expiry release,
one active-deadline refund after partial completion, and one bilateral split of
remaining principal. A later milestone must never submit before its predecessor releases.

Cancellation review must prove both `Created -> Cancelled` and
`Funded -> Cancelled`, including an exact funded-principal return and zero
remaining liability. The same call must revert in `ProviderAccepted` and every
later state.

Receipt, bytecode, Safe authority, deterministic salt, and source-verification
evidence are recorded in [`deployments/testnet-v3.json`](deployments/testnet-v3.json).
No mainnet transaction, private key, token approval, or escrow funding was used.
