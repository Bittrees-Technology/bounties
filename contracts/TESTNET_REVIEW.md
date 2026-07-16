# Base Sepolia testnet review packet

Status: source and deterministic local tests prepared; deployment template unexecuted.

## Intended review configuration

- Network: Base Sepolia (chain ID 84532), not yet selected for broadcast.
- Sender: unset; deployment-operator is the only default broadcaster.
- Target: new deployment; no address exists.
- Constructor: `ADMIN_ADDRESS`, `ARBITER_ADDRESS`, `GUARDIAN_ADDRESS`.
- Review token: `TOKEN_ADDRESS`; not transferred or approved by this task.
- Value: 0 native ETH in constructor and all v1 bounty operations.
- Calldata/gas/simulation: pending operator-selected addresses and preflight.
- Expected state change: deployment only, followed by role verification.
- Abort conditions: role mismatch, unsupported chain ID, failed simulation, unexpected
  token behavior, missing validator approval, or any funded/mainnet intent.
- Monitoring: deployment receipt, bytecode verification, role events, pause events,
  bounty transition events, and escrow/token balance reconciliation.

## Verification evidence

Foundry: `forge 1.7.1` (`4072e48705af9d93e3c0f6e29e93b5e9a40caed8`).

The exact final clean-build and test logs are saved in `forge-build-output.txt` and
`forge-test-output.txt`. The verified result is 40 compiled files and 15 passing tests:
11 deterministic unit/regression tests, one 256-run funding fuzz property, and three
256-run stateful invariants with 128,000 handler calls per invariant.

The timestamp comparisons are the explicit refund-deadline policy. Deadlines should
use operationally meaningful margins rather than exact block-second assumptions.

No RPC, fork, broadcast, funded transaction, or deployment command was run.
