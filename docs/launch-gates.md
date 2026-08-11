# Launch Controls

## Legal

- Draft escrow/payment terms.
- Draft contributor/IP and service work-product terms.
- Define refund, delivery review, and release-timing language.
- Review sanctions/AML, money-transmitter exposure, tax, and contributor classification issues.

## Security

- Threat model wallet auth and signer authority.
- Review input validation and stored criteria rendering.
- Review secrets, deployment environment, and domain setup.
- Review release/refund controls before any testnet contract deployment.
- Add spam/abuse prevention for permissionless service requests and provider listings.

## Onchain

- Rehearse independently on Ethereum Sepolia, Base Sepolia, and Robinhood Chain Testnet.
- Present every token by chain ID plus inspected contract address; never infer identity from a symbol.
- Use exact ERC20 approvals and operator-reviewed transaction simulations.
- Bind support and acceptance criteria by content hash before settlement.
- Keep production deployment blocked until auditor and deployment-operator preflight pass.

## Operations

- Verify GitHub write access, branch protection, labels, milestones, and project board.
- Provision deployment environment and domain only after implementation validation.
- Track launch blockers as issues before opening public marketplace orders.
