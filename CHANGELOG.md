# Changelog

All notable changes to Bittrees Bounties are documented here.

## Unreleased

### Added

- Generic services marketplace discovery and request flow.
- Task, milestone, project, and retainer work scopes.
- Provider matching, order pipeline, delivery evidence, acceptance criteria, and reviews.
- Escrow readiness states that clearly separate staged orders from live custody or payouts.
- Automated test, lint, build, dependency-audit, and tagged-release artifact checks.

### Safety boundaries

- This release does not deploy escrow contracts, custody funds, or execute payouts.
- Live payments remain gated on legal, security, and onchain approval.
- The MIT codebase is a clean-room implementation; incompatible upstream code is not included.
