// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IBountyEscrow} from "./IBountyEscrow.sol";

/// @title BountyEscrow
/// @notice Permissionless, exact-accounting ERC20 escrow for individual bounties.
/// @dev There is deliberately no administrator, arbiter, pause, dispute, or claims flow.
///
/// Commitment encoding (all strings are first converted to their bytes32 keccak256 domain):
/// - scopeHash: keccak256(abi.encode(keccak256("BOUNTY_SCOPE_V1"), chainId,
///   escrowAddress, requester, token, plannedAmount, deliveryDeadline, metadataHash, salt))
/// - termsHash: keccak256(abi.encode(keccak256("BOUNTY_TERMS_V1"), chainId,
///   escrowAddress, scopeHash, proposalHash, provider))
/// - evidenceHash: keccak256(abi.encode(keccak256("BOUNTY_EVIDENCE_V1"), chainId,
///   escrowAddress, bountyId, scopeHash, termsHash, provider, contentHash, uriHash, salt))
/// - approvalHash: keccak256(abi.encode(keccak256("BOUNTY_APPROVAL_V1"), chainId,
///   escrowAddress, bountyId, evidenceHash, requester, decisionHash, salt))
/// `contentHash` is the provider-supplied SHA-256 digest of the exact delivered file or
/// canonical bundle bytes; `uriHash` independently binds its location. The contract stores
/// the canonical commitment supplied by direct callers but intentionally cannot fetch or
/// interpret either preimage.
contract BountyEscrow is IBountyEscrow, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant override SCOPE_DOMAIN = keccak256("BOUNTY_SCOPE_V1");
    bytes32 public constant override TERMS_DOMAIN = keccak256("BOUNTY_TERMS_V1");
    bytes32 public constant override EVIDENCE_DOMAIN = keccak256("BOUNTY_EVIDENCE_V1");
    bytes32 public constant override APPROVAL_DOMAIN = keccak256("BOUNTY_APPROVAL_V1");
    bytes32 public constant override MILESTONE_SCHEDULE_DOMAIN = keccak256("BOUNTY_MILESTONE_SCHEDULE_V1");
    bytes32 public constant override MILESTONE_TERMS_DOMAIN = keccak256("BOUNTY_MILESTONE_TERMS_V1");
    uint64 public constant override REVIEW_PERIOD = 7 days;
    uint64 public constant override REVISION_PERIOD = 7 days;
    uint64 public constant override SETTLEMENT_PROPOSAL_PERIOD = 7 days;
    uint64 public constant override MIN_MILESTONE_SPACING = REVIEW_PERIOD + REVISION_PERIOD + REVIEW_PERIOD;
    uint32 public constant override MAX_MILESTONES = 32;

    uint256 public override nextBountyId = 1;
    mapping(address token => uint256 liability) public override totalLiability;
    mapping(address requester => mapping(bytes32 termsHash => uint256 bountyId))
        public
        override bountyIdByRequesterAndTermsHash;
    mapping(uint256 bountyId => Bounty bounty) private _bounties;
    mapping(uint256 bountyId => mapping(uint256 milestoneIndex => Milestone milestone)) private _milestones;

    /// @notice Creates a bounty and optionally funds it atomically.
    /// @param requestedAmount Exact ERC20 amount to pull, or zero for a record funded later.
    /// @param provider Selected provider wallet committed at creation time.
    /// @param proposalHash Proposal commitment that is bound to the selected provider.
    /// @param deliveryDeadline Required timestamp at which an accepted-but-undelivered bounty is
    ///        refundable. Acceptance and delivery require
    ///        `block.timestamp < deliveryDeadline`; refund requires `>=`.
    /// @dev Fee-on-transfer, sender-taxed, and other inexact deposits revert.
    function createBounty(
        address token,
        uint256 requestedAmount,
        uint64 deliveryDeadline,
        bytes32 scopeHash,
        address provider,
        bytes32 proposalHash
    ) external override nonReentrant returns (uint256 bountyId) {
        _validateCreation(token, deliveryDeadline, scopeHash, provider, proposalHash);

        bountyId = _reserveSingleCreation(scopeHash, proposalHash, provider);
        Bounty storage bounty = _bounties[bountyId];
        bounty.requester = msg.sender;
        bounty.provider = provider;
        bounty.token = IERC20(token);
        bounty.deliveryDeadline = deliveryDeadline;
        bounty.scopeHash = scopeHash;
        bounty.proposalHash = proposalHash;
        bounty.allocatedAmount = requestedAmount;
        bounty.milestoneCount = 1;
        bounty.scheduleHash = _singleMilestoneScheduleHash(scopeHash, requestedAmount, deliveryDeadline);
        bounty.state = State.Created;

        Milestone storage milestone = _milestones[bountyId][0];
        milestone.amount = requestedAmount;
        milestone.deliveryDeadline = deliveryDeadline;

        emit BountyCreated(
            bountyId,
            msg.sender,
            token,
            provider,
            requestedAmount,
            scopeHash,
            proposalHash,
            bounty.termsHash,
            deliveryDeadline
        );

        if (requestedAmount != 0) {
            _pullExact(bounty.token, msg.sender, requestedAmount);
            bounty.amount = requestedAmount;
            bounty.state = State.Funded;
            totalLiability[token] += requestedAmount;
            _requireSolvent(bounty.token);
            emit BountyFunded(bountyId, msg.sender, token, requestedAmount);
        }

        emit MilestoneScheduleCreated(bountyId, bounty.scheduleHash, 1, requestedAmount);
        emit MilestoneConfigured(bountyId, 0, requestedAmount, deliveryDeadline);
    }

    /// @notice Creates a sequential bounty with one positive allocation per deliverable.
    /// @dev `requestedAmount` is either zero for later exact funding or the exact sum of allocations.
    ///      Deadlines are mandatory and must increase strictly.
    function createMilestoneBounty(
        address token,
        uint256 requestedAmount,
        uint256[] calldata milestoneAmounts,
        uint64[] calldata milestoneDeadlines,
        bytes32 scopeHash,
        address provider,
        bytes32 proposalHash
    ) external override nonReentrant returns (uint256 bountyId) {
        _validateCreationIdentity(token, scopeHash, provider, proposalHash);
        uint256 allocatedAmount = _validateMilestoneSchedule(milestoneAmounts, milestoneDeadlines);
        if (requestedAmount != 0 && requestedAmount != allocatedAmount) {
            revert MilestoneFundingMismatch(allocatedAmount, requestedAmount);
        }

        bountyId = _reserveMilestoneCreation(scopeHash, proposalHash, provider, milestoneAmounts, milestoneDeadlines);
        Bounty storage bounty = _bounties[bountyId];
        bounty.requester = msg.sender;
        bounty.provider = provider;
        bounty.token = IERC20(token);
        bounty.deliveryDeadline = milestoneDeadlines[0];
        bounty.scopeHash = scopeHash;
        bounty.proposalHash = proposalHash;
        bounty.allocatedAmount = allocatedAmount;
        bounty.milestoneCount = uint32(milestoneAmounts.length);
        bounty.state = State.Created;

        _emitBountyCreated(bountyId, bounty, requestedAmount);
        emit MilestoneScheduleCreated(bountyId, bounty.scheduleHash, milestoneAmounts.length, allocatedAmount);
        _configureMilestones(bountyId, milestoneAmounts, milestoneDeadlines);

        if (requestedAmount != 0) {
            _pullExact(bounty.token, msg.sender, requestedAmount);
            bounty.amount = requestedAmount;
            bounty.state = State.Funded;
            totalLiability[token] += requestedAmount;
            _requireSolvent(bounty.token);
            emit BountyFunded(bountyId, msg.sender, token, requestedAmount);
        }
    }

    /// @notice Funds a previously created record with one exact, positive principal.
    function fundBounty(uint256 bountyId, uint256 amount) external override nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        _onlyRequester(bountyId, bounty);
        _onlyState(bountyId, bounty, State.Created);
        _requireBeforeDeadline(bountyId, bounty.deliveryDeadline);
        if (amount == 0) revert InvalidAmount(amount);
        uint256 allocatedAmount = bounty.allocatedAmount;
        if (allocatedAmount == 0) {
            bounty.allocatedAmount = amount;
            _milestones[bountyId][0].amount = amount;
            bounty.scheduleHash = _singleMilestoneScheduleHash(bounty.scopeHash, amount, bounty.deliveryDeadline);
            emit MilestoneScheduleCreated(bountyId, bounty.scheduleHash, 1, amount);
            emit MilestoneConfigured(bountyId, 0, amount, bounty.deliveryDeadline);
        } else if (amount != allocatedAmount) {
            revert MilestoneFundingMismatch(allocatedAmount, amount);
        }

        _pullExact(bounty.token, msg.sender, amount);
        bounty.amount = amount;
        bounty.state = State.Funded;
        totalLiability[address(bounty.token)] += amount;
        _requireSolvent(bounty.token);

        emit BountyFunded(bountyId, msg.sender, address(bounty.token), amount);
    }

    /// @notice Records acceptance from the provider committed at bounty creation.
    /// @dev Passing the expected hash prevents a provider from accepting stale or substituted terms.
    function acceptBounty(uint256 bountyId, bytes32 acceptedTermsHash) external override nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        _onlyState(bountyId, bounty, State.Funded);
        _requireBeforeDeadline(bountyId, bounty.deliveryDeadline);
        if (msg.sender != bounty.provider) revert InvalidProvider(msg.sender);
        if (acceptedTermsHash != bounty.termsHash) {
            revert TermsHashMismatch(bounty.termsHash, acceptedTermsHash);
        }
        _requireSolvent(bounty.token);

        bounty.acceptedTermsHash = acceptedTermsHash;
        _clearSettlement(bounty);
        bounty.state = State.ProviderAccepted;

        emit ProviderAccepted(bountyId, msg.sender, acceptedTermsHash);
    }

    /// @notice Commits immutable delivery evidence before the configured deadline.
    function submitDelivery(uint256 bountyId, bytes32 evidenceHash) external override nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        _onlyProvider(bountyId, bounty);
        _onlyState(bountyId, bounty, State.ProviderAccepted);
        _requireBeforeDeadline(bountyId, bounty.deliveryDeadline);
        if (evidenceHash == bytes32(0)) revert ZeroEvidenceHash();
        _requireSolvent(bounty.token);

        uint256 milestoneIndex = bounty.currentMilestone;
        Milestone storage milestone = _milestones[bountyId][milestoneIndex];
        if (milestone.revisionRequested && evidenceHash == milestone.previousEvidenceHash) {
            revert UnchangedRevisionEvidence(bountyId, milestoneIndex, evidenceHash);
        }
        bounty.evidenceHash = evidenceHash;
        bounty.reviewDeadline = uint64(block.timestamp) + REVIEW_PERIOD;
        milestone.evidenceHash = evidenceHash;
        milestone.reviewDeadline = bounty.reviewDeadline;
        milestone.state = MilestoneState.Submitted;
        _clearSettlement(bounty);
        bounty.state = State.Delivered;

        emit DeliverySubmitted(bountyId, msg.sender, evidenceHash, bounty.reviewDeadline);
        emit MilestoneSubmitted(bountyId, milestoneIndex, msg.sender, evidenceHash, bounty.reviewDeadline);
    }

    /// @notice Records the requester's immutable approval commitment.
    function approveDelivery(uint256 bountyId, bytes32 approvalHash) external override nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        _onlyRequester(bountyId, bounty);
        _onlyState(bountyId, bounty, State.Delivered);
        if (approvalHash == bytes32(0)) revert ZeroApprovalHash();
        _requireSolvent(bounty.token);

        uint256 milestoneIndex = bounty.currentMilestone;
        Milestone storage milestone = _milestones[bountyId][milestoneIndex];
        bounty.approvalHash = approvalHash;
        milestone.approvalHash = approvalHash;
        milestone.state = MilestoneState.Approved;
        _clearSettlement(bounty);
        bounty.state = State.BuyerApproved;

        emit BuyerApproved(bountyId, msg.sender, approvalHash);
        emit MilestoneApproved(bountyId, milestoneIndex, msg.sender, approvalHash);
    }

    /// @notice Gives the provider one fixed seven-day resubmission period for the active milestone.
    /// @dev The requester may use this once per milestone and only while the original review period is active.
    function requestRevision(uint256 bountyId, bytes32 reasonHash) external override nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        _onlyRequester(bountyId, bounty);
        _onlyState(bountyId, bounty, State.Delivered);
        if (reasonHash == bytes32(0)) revert ZeroRevisionReasonHash();
        uint64 reviewDeadline = bounty.reviewDeadline;
        if (block.timestamp >= reviewDeadline) revert RevisionWindowClosed(bountyId, reviewDeadline);

        uint256 milestoneIndex = bounty.currentMilestone;
        Milestone storage milestone = _milestones[bountyId][milestoneIndex];
        if (milestone.revisionRequested) revert RevisionAlreadyRequested(bountyId, milestoneIndex);
        _requireSolvent(bounty.token);

        uint64 revisionDeadline = uint64(block.timestamp) + REVISION_PERIOD;
        milestone.revisionRequested = true;
        milestone.revisionReasonHash = reasonHash;
        milestone.revisionDeadline = revisionDeadline;
        milestone.reviewDeadline = 0;
        milestone.previousEvidenceHash = milestone.evidenceHash;
        milestone.evidenceHash = bytes32(0);
        milestone.approvalHash = bytes32(0);
        milestone.state = MilestoneState.Pending;
        bounty.deliveryDeadline = revisionDeadline;
        bounty.reviewDeadline = 0;
        bounty.evidenceHash = bytes32(0);
        bounty.approvalHash = bytes32(0);
        _clearSettlement(bounty);
        bounty.state = State.ProviderAccepted;

        emit MilestoneRevisionRequested(bountyId, milestoneIndex, msg.sender, reasonHash, revisionDeadline);
    }

    /// @notice Pays a bounty to its provider after buyer approval or expiry of its delivery review period.
    /// @dev Anyone may trigger the owed full payment. The review boundary is inclusive.
    function release(uint256 bountyId) external override nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        State current = bounty.state;
        if (current == State.Delivered) {
            uint64 reviewDeadline = bounty.reviewDeadline;
            if (block.timestamp < reviewDeadline) revert ReviewPeriodActive(bountyId, reviewDeadline);
        } else if (current != State.BuyerApproved) {
            revert InvalidState(bountyId, current, State.BuyerApproved);
        }

        IERC20 token = bounty.token;
        address provider = bounty.provider;
        uint256 milestoneIndex = bounty.currentMilestone;
        Milestone storage milestone = _milestones[bountyId][milestoneIndex];
        uint256 amount = milestone.amount;
        _requireSolvent(token);

        bounty.amount -= amount;
        bounty.releasedAmount += amount;
        milestone.state = MilestoneState.Released;
        uint256 remainingLiability = totalLiability[address(token)] - amount;
        totalLiability[address(token)] = remainingLiability;

        emit MilestoneReleased(bountyId, milestoneIndex, provider, address(token), amount, bounty.amount);
        if (milestoneIndex + 1 == bounty.milestoneCount) {
            _clearSettlement(bounty);
            bounty.state = State.Released;
            emit BountyReleased(bountyId, provider, address(token), bounty.releasedAmount);
        } else {
            // Safe because creation rejects schedules longer than MAX_MILESTONES, which fits in uint32.
            // forge-lint: disable-next-line(unsafe-typecast)
            bounty.currentMilestone = uint32(milestoneIndex + 1);
            bounty.deliveryDeadline = _milestones[bountyId][milestoneIndex + 1].deliveryDeadline;
            bounty.reviewDeadline = 0;
            bounty.evidenceHash = bytes32(0);
            bounty.approvalHash = bytes32(0);
            _clearSettlement(bounty);
            bounty.state = State.ProviderAccepted;
        }
        _pushExact(token, provider, amount, remainingLiability);
    }

    /// @notice Records an exact, time-bounded provider payout proposed by the requester or provider.
    /// @dev A newer proposal from either party replaces the prior one. Zero is a valid provider payout.
    ///      The offer lasts at most seven days and is shortened to the active delivery or review deadline.
    function proposeSettlement(uint256 bountyId, uint256 providerPayout) external override nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        _onlySettlementState(bountyId, bounty);
        _onlyParty(bountyId, bounty);
        uint256 principal = bounty.amount;
        if (providerPayout > principal) {
            revert SettlementAmountExceedsPrincipal(bountyId, providerPayout, principal);
        }
        _requireSolvent(bounty.token);

        uint64 expiry = _settlementProposalExpiry(bountyId, bounty);

        bounty.settlementProposer = msg.sender;
        bounty.proposedProviderPayout = providerPayout;
        bounty.settlementProposalExpiry = expiry;

        emit SettlementProposed(bountyId, msg.sender, providerPayout, expiry);
    }

    /// @notice Accepts the counterparty's exact proposal and atomically splits the escrow principal.
    /// @dev The supplied amount protects the acceptor against a proposal replacement before execution.
    function acceptSettlement(uint256 bountyId, uint256 providerPayout) external override nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        _onlySettlementState(bountyId, bounty);
        _onlyParty(bountyId, bounty);

        address proposer = bounty.settlementProposer;
        if (proposer == address(0) || proposer == msg.sender) {
            revert SettlementAcceptanceUnavailable(bountyId, msg.sender, proposer);
        }
        uint64 expiry = bounty.settlementProposalExpiry;
        if (expiry == 0 || block.timestamp >= expiry) revert SettlementProposalExpired(bountyId, expiry);
        uint256 proposedProviderPayout = bounty.proposedProviderPayout;
        if (providerPayout != proposedProviderPayout) {
            revert SettlementProposalMismatch(bountyId, proposedProviderPayout, providerPayout);
        }

        IERC20 token = bounty.token;
        uint256 principal = bounty.amount;
        uint256 requesterRefund = principal - providerPayout;
        _requireSolvent(token);

        bounty.amount = 0;
        _clearSettlement(bounty);
        bounty.state = State.Settled;
        uint256 remainingLiability = totalLiability[address(token)] - principal;
        totalLiability[address(token)] = remainingLiability;

        emit BountySettled(
            bountyId,
            bounty.provider,
            bounty.requester,
            address(token),
            proposer,
            msg.sender,
            providerPayout,
            requesterRefund
        );
        if (providerPayout != 0) {
            _pushExact(token, bounty.provider, providerPayout, remainingLiability + requesterRefund);
        }
        if (requesterRefund != 0) {
            _pushExact(token, bounty.requester, requesterRefund, remainingLiability);
        }
    }

    /// @notice Cancels the current settlement proposal without changing the bounty lifecycle.
    /// @dev Only the current proposer can cancel. An expired offer may still be cleared explicitly.
    function cancelSettlementProposal(uint256 bountyId) external override nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        address proposer = bounty.settlementProposer;
        if (proposer == address(0) || msg.sender != proposer) {
            revert SettlementProposalCancellationUnavailable(bountyId, msg.sender, proposer);
        }

        _clearSettlement(bounty);
        emit SettlementProposalCancelled(bountyId, proposer);
    }

    /// @notice Cancels a bounty before the committed provider has accepted it onchain.
    /// @dev A funded cancellation refunds exact principal and still terminates as `Cancelled`.
    function cancelBounty(uint256 bountyId) external override nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        _onlyRequester(bountyId, bounty);
        State current = bounty.state;
        if (current != State.Created && current != State.Funded) {
            revert CancellationUnavailable(bountyId, current);
        }

        IERC20 token = bounty.token;
        uint256 amount = bounty.amount;
        if (amount != 0) _requireSolvent(token);

        bounty.amount = 0;
        _clearSettlement(bounty);
        bounty.state = State.Cancelled;
        uint256 remainingLiability = totalLiability[address(token)] - amount;
        totalLiability[address(token)] = remainingLiability;

        emit BountyCancelled(bountyId, msg.sender, address(token), amount);
        if (amount != 0) _pushExact(token, msg.sender, amount, remainingLiability);
    }

    /// @notice Refunds a funded bounty that was not delivered before its deadline.
    /// @dev Anyone may trigger the deterministic refund, but funds always return to the requester.
    ///      The exact boundary is inclusive: `block.timestamp >= deliveryDeadline`.
    function refundBounty(uint256 bountyId) external override nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        State current = bounty.state;
        if (current != State.Funded && current != State.ProviderAccepted) {
            revert InvalidState(bountyId, current, State.ProviderAccepted);
        }

        uint64 deliveryDeadline = bounty.deliveryDeadline;
        if (deliveryDeadline == 0 || block.timestamp < deliveryDeadline) {
            revert RefundNotAvailable(bountyId, deliveryDeadline);
        }

        IERC20 token = bounty.token;
        uint256 amount = bounty.amount;
        _requireSolvent(token);

        bounty.amount = 0;
        _clearSettlement(bounty);
        bounty.state = State.Refunded;
        uint256 remainingLiability = totalLiability[address(token)] - amount;
        totalLiability[address(token)] = remainingLiability;

        emit BountyRefunded(bountyId, bounty.requester, address(token), amount, deliveryDeadline);
        _pushExact(token, bounty.requester, amount, remainingLiability);
    }

    function getBounty(uint256 bountyId) external view override returns (Bounty memory) {
        return _getBounty(bountyId);
    }

    function getMilestone(uint256 bountyId, uint256 milestoneIndex) external view override returns (Milestone memory) {
        Bounty storage bounty = _getBounty(bountyId);
        if (milestoneIndex >= bounty.milestoneCount) revert MilestoneNotFound(bountyId, milestoneIndex);
        return _milestones[bountyId][milestoneIndex];
    }

    function _validateCreation(
        address token,
        uint64 deliveryDeadline,
        bytes32 scopeHash,
        address provider,
        bytes32 proposalHash
    ) private view {
        _validateCreationIdentity(token, scopeHash, provider, proposalHash);
        if (deliveryDeadline <= block.timestamp) {
            revert InvalidDeadline(deliveryDeadline);
        }
    }

    function _validateCreationIdentity(address token, bytes32 scopeHash, address provider, bytes32 proposalHash)
        private
        view
    {
        if (token == address(0)) revert ZeroAddress();
        if (token.code.length == 0) revert InvalidToken(token);
        if (scopeHash == bytes32(0)) revert ZeroScopeHash();
        if (proposalHash == bytes32(0)) revert ZeroProposalHash();
        if (provider == address(0) || provider == msg.sender || provider == address(this)) {
            revert InvalidProvider(provider);
        }
    }

    function _termsHash(bytes32 scopeHash, bytes32 proposalHash, address provider) private view returns (bytes32) {
        return keccak256(abi.encode(TERMS_DOMAIN, block.chainid, address(this), scopeHash, proposalHash, provider));
    }

    /// @dev A committed bounty may be created only once per requester. The reservation is
    ///      deliberately permanent: a replacement must use a fresh scope commitment so a
    ///      delayed or replayed wallet request cannot pull the principal a second time.
    function _requireUniqueCreation(address requester, bytes32 termsHash) private view {
        uint256 existingBountyId = bountyIdByRequesterAndTermsHash[requester][termsHash];
        if (existingBountyId != 0) revert DuplicateBounty(requester, termsHash, existingBountyId);
    }

    function _reserveMilestoneCreation(
        bytes32 scopeHash,
        bytes32 proposalHash,
        address provider,
        uint256[] calldata milestoneAmounts,
        uint64[] calldata milestoneDeadlines
    ) private returns (uint256 bountyId) {
        bytes32 scheduleHash = keccak256(
            abi.encode(
                MILESTONE_SCHEDULE_DOMAIN, block.chainid, address(this), scopeHash, milestoneAmounts, milestoneDeadlines
            )
        );
        bytes32 termsHash = keccak256(
            abi.encode(
                MILESTONE_TERMS_DOMAIN, block.chainid, address(this), scopeHash, proposalHash, provider, scheduleHash
            )
        );
        _requireUniqueCreation(msg.sender, termsHash);
        bountyId = nextBountyId++;
        bountyIdByRequesterAndTermsHash[msg.sender][termsHash] = bountyId;
        _bounties[bountyId].scheduleHash = scheduleHash;
        _bounties[bountyId].termsHash = termsHash;
    }

    function _reserveSingleCreation(bytes32 scopeHash, bytes32 proposalHash, address provider)
        private
        returns (uint256 bountyId)
    {
        bytes32 termsHash = _termsHash(scopeHash, proposalHash, provider);
        _requireUniqueCreation(msg.sender, termsHash);
        bountyId = nextBountyId++;
        bountyIdByRequesterAndTermsHash[msg.sender][termsHash] = bountyId;
        _bounties[bountyId].termsHash = termsHash;
    }

    function _singleMilestoneScheduleHash(bytes32 scopeHash, uint256 amount, uint64 deliveryDeadline)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(MILESTONE_SCHEDULE_DOMAIN, block.chainid, address(this), scopeHash, amount, deliveryDeadline)
        );
    }

    function _emitBountyCreated(uint256 bountyId, Bounty storage bounty, uint256 requestedAmount) private {
        emit BountyCreated(
            bountyId,
            bounty.requester,
            address(bounty.token),
            bounty.provider,
            requestedAmount,
            bounty.scopeHash,
            bounty.proposalHash,
            bounty.termsHash,
            bounty.deliveryDeadline
        );
    }

    function _validateMilestoneSchedule(uint256[] calldata amounts, uint64[] calldata deadlines)
        private
        view
        returns (uint256 allocatedAmount)
    {
        uint256 count = amounts.length;
        if (count == 0 || count > MAX_MILESTONES) revert InvalidMilestoneCount(count);
        if (count != deadlines.length) revert MilestoneArrayLengthMismatch(count, deadlines.length);

        uint64 previousDeadline;
        for (uint256 i; i < count; ++i) {
            uint256 amount = amounts[i];
            if (amount == 0) revert InvalidMilestoneAmount(i, amount);
            allocatedAmount += amount;

            uint64 deadline = deadlines[i];
            if (
                deadline <= block.timestamp
                    || (previousDeadline != 0 && uint256(deadline) <= uint256(previousDeadline) + MIN_MILESTONE_SPACING)
            ) {
                revert InvalidMilestoneDeadline(i, previousDeadline, deadline);
            }
            previousDeadline = deadline;
        }
    }

    function _configureMilestones(uint256 bountyId, uint256[] calldata amounts, uint64[] calldata deadlines) private {
        for (uint256 i; i < amounts.length; ++i) {
            Milestone storage milestone = _milestones[bountyId][i];
            milestone.amount = amounts[i];
            milestone.deliveryDeadline = deadlines[i];
            emit MilestoneConfigured(bountyId, i, amounts[i], deadlines[i]);
        }
    }

    function _pullExact(IERC20 token, address from, uint256 amount) private {
        uint256 balanceBefore = token.balanceOf(address(this));
        uint256 senderBalanceBefore = token.balanceOf(from);
        token.safeTransferFrom(from, address(this), amount);
        uint256 balanceAfter = token.balanceOf(address(this));
        uint256 senderBalanceAfter = token.balanceOf(from);
        uint256 received = balanceAfter >= balanceBefore ? balanceAfter - balanceBefore : 0;
        uint256 debited = senderBalanceBefore >= senderBalanceAfter ? senderBalanceBefore - senderBalanceAfter : 0;
        if (received != amount) revert FundingAmountMismatch(address(token), amount, received);
        if (debited != amount) revert FundingDebitMismatch(address(token), amount, debited);
    }

    function _clearSettlement(Bounty storage bounty) private {
        bounty.settlementProposer = address(0);
        bounty.proposedProviderPayout = 0;
        bounty.settlementProposalExpiry = 0;
    }

    function _settlementProposalExpiry(uint256 bountyId, Bounty storage bounty) private view returns (uint64 expiry) {
        uint256 maximumExpiry = block.timestamp + SETTLEMENT_PROPOSAL_PERIOD;
        // This branch is unreachable on present-day networks but keeps the cast fail-closed at uint64 exhaustion.
        // forge-lint: disable-next-line(unsafe-typecast)
        expiry = maximumExpiry > type(uint64).max ? type(uint64).max : uint64(maximumExpiry);
        State current = bounty.state;
        uint64 lifecycleDeadline;
        if (current == State.Funded || current == State.ProviderAccepted) {
            lifecycleDeadline = bounty.deliveryDeadline;
        } else if (current == State.Delivered) {
            lifecycleDeadline = bounty.reviewDeadline;
        }
        if (lifecycleDeadline != 0) {
            if (block.timestamp >= lifecycleDeadline) revert SettlementWindowClosed(bountyId, lifecycleDeadline);
            if (lifecycleDeadline < expiry) expiry = lifecycleDeadline;
        }
    }

    function _pushExact(IERC20 token, address recipient, uint256 amount, uint256 remainingLiability) private {
        uint256 escrowBalanceBefore = token.balanceOf(address(this));
        uint256 recipientBalanceBefore = token.balanceOf(recipient);

        token.safeTransfer(recipient, amount);

        uint256 escrowBalanceAfter = token.balanceOf(address(this));
        uint256 recipientBalanceAfter = token.balanceOf(recipient);
        bool exactEscrowDebit =
            escrowBalanceAfter <= escrowBalanceBefore && escrowBalanceBefore - escrowBalanceAfter == amount;
        bool exactRecipientCredit =
            recipientBalanceAfter >= recipientBalanceBefore && recipientBalanceAfter - recipientBalanceBefore == amount;
        if (!exactEscrowDebit || !exactRecipientCredit) {
            revert SettlementAmountMismatch(
                address(token),
                amount,
                escrowBalanceBefore,
                escrowBalanceAfter,
                recipientBalanceBefore,
                recipientBalanceAfter
            );
        }
        if (escrowBalanceAfter < remainingLiability) {
            revert InsolventToken(address(token), escrowBalanceAfter, remainingLiability);
        }
    }

    function _requireSolvent(IERC20 token) private view {
        uint256 balance = token.balanceOf(address(this));
        uint256 liability = totalLiability[address(token)];
        if (balance < liability) revert InsolventToken(address(token), balance, liability);
    }

    function _getBounty(uint256 bountyId) private view returns (Bounty storage bounty) {
        bounty = _bounties[bountyId];
        if (bounty.requester == address(0)) revert BountyNotFound(bountyId);
    }

    function _onlyRequester(uint256 bountyId, Bounty storage bounty) private view {
        if (msg.sender != bounty.requester) revert UnauthorizedActor(bountyId, msg.sender);
    }

    function _onlyProvider(uint256 bountyId, Bounty storage bounty) private view {
        if (msg.sender != bounty.provider) revert UnauthorizedActor(bountyId, msg.sender);
    }

    function _onlyParty(uint256 bountyId, Bounty storage bounty) private view {
        if (msg.sender != bounty.requester && msg.sender != bounty.provider) {
            revert UnauthorizedActor(bountyId, msg.sender);
        }
    }

    function _onlySettlementState(uint256 bountyId, Bounty storage bounty) private view {
        State current = bounty.state;
        if (
            current != State.Funded && current != State.ProviderAccepted && current != State.Delivered
                && current != State.BuyerApproved
        ) {
            revert SettlementUnavailable(bountyId, current);
        }
    }

    function _onlyState(uint256 bountyId, Bounty storage bounty, State required) private view {
        if (bounty.state != required) revert InvalidState(bountyId, bounty.state, required);
    }

    function _requireBeforeDeadline(uint256 bountyId, uint64 deliveryDeadline) private view {
        if (block.timestamp >= deliveryDeadline) {
            revert DeadlineExpired(bountyId, deliveryDeadline);
        }
    }
}
