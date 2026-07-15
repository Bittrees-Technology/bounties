# Bittrees Bounties

Clean-room MVP for `bounties.bittrees.org`.

The product goal is to let anyone create a bounty for a task, milestone, or project, define support and acceptance criteria, and track escrow intent through review and payout. This repository uses `stigmergic-org/simplebounty` as product/architecture reference only until licensing is resolved; it does not copy the GPLv3 source into this MIT repository.

## Current scope

- Create a bounty with task, milestone, or project scope.
- Capture reward token/amount, creator/reviewer, support criteria, and acceptance criteria.
- Track escrow status as a gated workflow.
- Surface launch gates for legal, security, onchain, and licensing review.

## Hard gates

Production escrow and value-bearing contract deployment are blocked until:

- Legal signs off on escrow/payment terms, contributor/IP language, disputes, sanctions/AML posture, and contributor classification.
- Security signs off on wallet auth, signing, input validation, secrets, release/refund/dispute logic, and abuse prevention.
- Onchain preflight completes on Base Sepolia with review from an auditor and deployment operator.
- The operator chooses the license path for the SimpleBounty fork: adopt GPLv3 for derivative code, secure relicense permission, or continue with clean-room implementation.

## Development

```bash
npm install
npm test
npm run build
npm run dev
```

## Suggested board columns

`Backlog/Triage -> Available -> Claimed/In Progress -> In Review -> Approved for Payout -> Paid/Closed`

## Initial backlog

- Connect wallet auth and signer identity.
- Persist bounties in an API/database instead of local state.
- Add issue/GitHub project sync.
- Add Base Sepolia escrow contract prototype after legal/security gates.
- Add refund, dispute, and arbiter workflows.
- Add notifications and contributor reputation.
