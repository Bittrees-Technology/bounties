# Bounty escrow contracts

`BountyEscrow` is a permissionless, ERC20-only escrow. A bounty is a record and
never an NFT. The contract has no owner, administrator, arbiter, token allowlist,
cap, pause, dispute, or claims flow.

Native ETH is not accepted. Product surfaces that say ETH must pass a WETH ERC20
address. Token symbols, decimals, names, and offchain prices are never read.

## Lifecycle

```text
Created -> Funded -> ProviderAccepted -> Delivered -> BuyerApproved -> Released
    |          |              |
    +----------+-> Cancelled  +-> Refunded (at/after deliveryDeadline)
```

- Anyone can create a record.
- The requester alone funds it, approves delivery, cancels before provider
  acceptance, or claims the deterministic timeout refund.
- Any non-requester can accept the exact committed terms and become the provider.
- Only that provider can submit the immutable evidence commitment.
- Anyone can trigger release after buyer approval; payout always goes to the
  recorded provider.
- `deliveryDeadline == 0` disables timeout. Otherwise acceptance and delivery
  require `block.timestamp < deliveryDeadline`; refund requires
  `block.timestamp >= deliveryDeadline`.
- There is intentionally no timeout after valid delivery. If the requester does
  not approve, no third party can adjudicate the work in this product.

Terminal transfers follow checks-effects-interactions, zero principal and reduce
per-token liability before the external call, and are guarded against reentrancy.
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
