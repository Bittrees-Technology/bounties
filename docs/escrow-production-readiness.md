# Escrow production readiness

Status: **testnet review candidate; production deployment remains NO-GO**.

The repository now includes an original Foundry escrow implementation, deterministic tests, a stateful invariant campaign, deployment templates, and a mocked application integration boundary. None of this constitutes an audit, legal approval, deployment authorization, or custody approval.

## Proposed v1 boundary

- One ERC20 deposit per bounty; native ETH and rebasing tokens are unsupported.
- Lifecycle: create, fund, assign, deliver, accept, release, refund, dispute, resolve.
- Requester controls scope acceptance and pre-assignment cancellation.
- Provider controls delivery; requester or provider may raise a dispute.
- A Safe-controlled arbiter resolves disputed funds; a separate guardian may pause only new liabilities.
- Release, refund, and dispute resolution remain available while paused so principal cannot be stranded.
- Production should start with allowlisted USDC, explicit per-bounty/aggregate caps, and no upgrade proxy unless a reviewed timelock design is approved.

## Required launch sequence

1. **Specification freeze** — approve chain, token, bounty caps, timeout/grace periods, evidence/content-hash binding, fee policy, arbiter powers, appeal policy, and whether partial milestones are separate escrows.
2. **Contract hardening** — add multi-bounty/token conservation, malicious-token, timeout/dispute-race, and role-rotation campaigns; run Slither and gas snapshots; resolve all high/medium findings.
3. **Independent audit** — commission an external auditor after the specification freeze; publish the report and fixes; rerun the full suite against the audited commit.
4. **Authority setup** — create separate hardware-backed Safe accounts for admin/guardian and arbiter roles; document thresholds, signer rotation, emergency access, and deployer-role renunciation.
5. **Legal/compliance approval** — publish escrow terms covering custody characterization, buyer/provider IP, refunds/disputes, sanctions/AML posture, tax/reporting, contributor classification, jurisdiction, and privacy.
6. **Base Sepolia soak** — deploy from a release tag, verify source, validate roles, exercise every lifecycle branch, reconcile events against token balances, and run monitoring for at least one full release cycle.
7. **Operations readiness** — alert on pauses, role changes, disputes, unexpected balances, failed transactions, and cap breaches; rehearse incident response and frontend rollback.
8. **Production canary** — operator-approved deployment with small allowlisted USDC caps, limited active bounties, and a documented 72-hour review before raising limits.

## Operator decisions still required

- Final network and chain ID (current plan assumes Base Sepolia before Base production).
- Approved USDC token address and token-behavior policy.
- Admin/guardian and arbiter Safe addresses, signer identities, and thresholds.
- Maximum bounty, aggregate TVL, active-bounty, and daily-release limits.
- Refund timeout, provider grace period, dispute evidence, appeal, and arbiter-liability policy.
- Contracting entity, custody/MSB/VASP assessment, IP/NDA owner, sanctions/AML controls, and payout tax/reporting entity.
- External auditor, bug-bounty budget, RPC/indexing providers, monitoring owner, and deployment gas budget.

## Go-live evidence packet

The production decision must reference one immutable release commit and contain:

- passing frontend and Foundry outputs, invariant configuration, static-analysis reports, and independent audit;
- verified contract address, constructor arguments, bytecode hash, chain/token IDs, and Safe role proofs;
- testnet receipts for create/fund/assign/deliver/accept/release/refund/dispute/resolve and pause-scope checks;
- signed legal, security, onchain, and operations GO/NO-GO decisions;
- monitoring dashboards, alert tests, incident contacts, rollback instructions, and canary caps.

No private key, mnemonic, RPC secret, or funded deployment command belongs in this repository.
