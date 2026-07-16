# Launch Controls

## Legal

- Draft escrow/payment terms.
- Draft contributor/IP and service work-product terms.
- Define dispute, refund, and acceptance authority language.
- Review sanctions/AML, money-transmitter exposure, tax, and contributor classification issues.

## Security

- Threat model wallet auth and signer authority.
- Review input validation and stored criteria rendering.
- Review secrets, deployment environment, and domain setup.
- Review release/refund/dispute controls before any testnet contract deployment.
- Add spam/abuse prevention for permissionless service requests and provider listings.

## Onchain

- Prototype on Base Sepolia only.
- Prefer USDC on Base for payout UX once production is approved.
- Use exact approvals and Safe-controlled treasury orders.
- Bind support and acceptance criteria by content hash before settlement.
- Keep production deployment blocked until auditor and deployment-operator preflight pass.

## Operations

- Verify GitHub write access, branch protection, labels, milestones, and project board.
- Provision deployment environment and domain only after implementation validation.
- Track launch blockers as issues before opening public marketplace orders.
