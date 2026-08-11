# Multi-network testnet review packet

Status: source and deterministic local tests prepared; deployment template unexecuted.

## Intended review configuration

- Networks: Ethereum Sepolia (11155111), Base Sepolia (84532), and Robinhood
  Chain Testnet (46630), none selected for broadcast in this repository.
- Sender: unset; deployment-operator is the only default broadcaster.
- Target: one new deployment per test network; no contract address exists.
- Constructor: none; the contract creates no administrator or privileged role.
- Review token: `TOKEN_ADDRESS`; not transferred or approved by this task.
- Value: 0 native ETH in constructor and all v1 bounty operations.
- Calldata/gas/simulation: pending operator-selected addresses and preflight.
- Expected state change: deployment only, followed by source and bytecode verification.
- Abort conditions: bytecode mismatch, unsupported chain ID, failed simulation, unexpected
  token behavior, missing validator approval, or any funded/mainnet intent.
- Monitoring: deployment receipt, bytecode verification, bounty transition events,
  finality/reorg signals, and escrow/token balance reconciliation.

## Verification evidence

Foundry: `forge 1.7.1` (`4072e48705af9d93e3c0f6e29e93b5e9a40caed8`).

The current release gate reruns `forge fmt --check`, `forge build`, and `forge test`
from the contract package rather than relying on checked-in generated logs. The
verified suite contains 22 deterministic unit regressions, five 256-run fuzz
properties, and three 64-run stateful invariants with 8,192 handler calls per
invariant under the checked-in Foundry profile.

Timestamp comparisons cover both boundaries: timeout refund is available at
`deliveryDeadline`, while permissionless full release is available at the stored
`reviewDeadline = delivery timestamp + 7 days`. Deadlines should use operationally
meaningful margins rather than exact block-second assumptions. The suite also
exercises requester/provider settlement proposals, counterparty-only acceptance,
exact split conservation, and atomic failure/reentrancy behavior.

No RPC, fork, broadcast, funded transaction, or deployment command was run.
