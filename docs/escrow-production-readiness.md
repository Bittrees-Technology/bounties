# Escrow production readiness

Status: **testnet review candidate; production deployment remains NO-GO**.

The repository includes an original Foundry escrow implementation, deterministic and stateful invariant tests, a fail-closed wallet adapter, wallet-only persistence, and server-verified escrow observations. None of this constitutes an audit, legal approval, deployment authorization, or custody approval.

## Proposed v1 boundary

- One ERC20 deposit per bounty; ETH is represented by WETH. Fee-on-transfer, false-return, and rebasing behavior fail closed.
- Lifecycle: create, fund, provider accept, deliver, then immediate full release
  after buyer approval or permissionless full release after a stored seven-day
  review deadline; pre-acceptance cancel and post-delivery-deadline refund remain.
- In funded, provider-accepted, or delivered states, either party may propose an
  exact provider payout and only the counterparty may accept, atomically paying
  the provider and refunding the full remainder to the requester.
- Requester controls scope acceptance and pre-assignment cancellation.
- The selected provider controls acceptance and delivery; only the requester can approve delivery.
- No arbiter, pause role, allowlist, marketplace administrator, or dispute path exists in Bounties.
- WETH, BTREE, BIT, WBTC, USDC, and USDT are curated labels, but identity is always chain ID plus inspected contract address. Any ERC20 may be added through the same inspection boundary.
- Claims or disputes belong to a future independent `claims.bittrees.org` product and cannot gain authority over this escrow by implication.

## Required launch sequence

1. **Specification freeze** — approve chain, the implemented seven-day delivery-review policy, bilateral settlement wording, token presentation, evidence/content-hash binding, and whether partial milestones are separate escrows.
2. **Contract hardening** — maintain multi-bounty/token conservation, malicious-token and deadline-boundary campaigns; run Slither and gas snapshots; resolve all high/medium findings.
3. **Independent audit** — commission an external auditor after the specification freeze; publish the report and fixes; rerun the full suite against the audited commit.
4. **Deployment authority** — use the operations-controlled deployment process, verify source and bytecode, document the deployer, and confirm the deployer receives no runtime authority over user records or escrow outcomes.
5. **Legal/compliance approval** — publish escrow terms covering custody characterization, buyer/provider IP, refunds, sanctions/AML posture, tax/reporting, contributor classification, jurisdiction, and privacy.
6. **Three-testnet soak** — separately deploy from a release tag to Ethereum
   Sepolia, Base Sepolia, and Robinhood Chain Testnet; verify source, exercise
   every lifecycle branch, reconcile events against token balances, and run
   monitoring for at least one full release cycle on each network.
7. **Operations readiness** — alert on unexpected balances, failed transactions, receipt-reconciliation failures, and application rollback conditions; rehearse incident response and frontend rollback.
8. **Production canary** — operator-approved deployment with clearly published risk limits and a documented observation period before widening use.

## Operator decisions still required

- Per-network launch approval for Ethereum (1/11155111), Base (8453/84532), and
  Robinhood Chain (4663/46630); a successful testnet soak does not approve mainnet.
- Verified chain-specific addresses for every curated token displayed by default; BTREE and BIT remain disabled until supplied.
- Operational presentation of the fixed seven-day review deadline and bilateral settlement proposal lifecycle.
- Whether each milestone uses a separate escrow or one bounty-level escrow record.
- Contracting entity, custody/MSB/VASP assessment, IP/NDA owner, sanctions/AML controls, and payout tax/reporting entity.
- External auditor, bug-bounty budget, RPC/indexing providers, monitoring owner, and deployment gas budget.

## Go-live evidence packet

The production decision must reference one immutable release commit and contain:

- passing frontend and Foundry outputs, invariant configuration, static-analysis reports, and independent audit;
- verified contract address, source, bytecode hash, and chain/token IDs;
- testnet receipts for create/fund/provider-accept/deliver/buyer-approve/review-expiry release/bilateral settlement/cancel/refund and exact-accounting checks;
- signed legal, security, onchain, and operations GO/NO-GO decisions;
- monitoring dashboards, alert tests, incident contacts, rollback instructions, and canary caps.

No private key, mnemonic, RPC secret, or funded deployment command belongs in this repository.
