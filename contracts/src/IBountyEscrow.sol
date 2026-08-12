// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IBountyEscrow
/// @notice Stable interface for a permissionless, ERC20-only bounty escrow.
/// @dev Native ETH is unsupported. A UI may represent WETH as ETH, but the escrow only
///      accepts ERC20 contract addresses and never inspects token metadata or prices.
interface IBountyEscrow {
    enum MilestoneState {
        Pending,
        Submitted,
        Approved,
        Released
    }

    enum State {
        Created,
        Funded,
        ProviderAccepted,
        Delivered,
        BuyerApproved,
        Released,
        Cancelled,
        Refunded,
        Settled
    }

    struct Bounty {
        address requester;
        address provider;
        IERC20 token;
        uint256 amount;
        uint64 deliveryDeadline;
        uint64 reviewDeadline;
        State state;
        bytes32 scopeHash;
        bytes32 proposalHash;
        bytes32 termsHash;
        bytes32 acceptedTermsHash;
        bytes32 evidenceHash;
        bytes32 approvalHash;
        address settlementProposer;
        uint256 proposedProviderPayout;
        uint64 settlementProposalExpiry;
        uint256 allocatedAmount;
        uint256 releasedAmount;
        uint32 milestoneCount;
        uint32 currentMilestone;
        bytes32 scheduleHash;
    }

    struct Milestone {
        uint256 amount;
        uint64 deliveryDeadline;
        uint64 reviewDeadline;
        uint64 revisionDeadline;
        MilestoneState state;
        bytes32 evidenceHash;
        bytes32 previousEvidenceHash;
        bytes32 approvalHash;
        bytes32 revisionReasonHash;
        bool revisionRequested;
    }

    error ZeroAddress();
    error InvalidToken(address token);
    error InvalidProvider(address provider);
    error InvalidDeadline(uint64 deliveryDeadline);
    error InvalidAmount(uint256 amount);
    error ZeroScopeHash();
    error ZeroProposalHash();
    error ZeroEvidenceHash();
    error UnchangedRevisionEvidence(uint256 bountyId, uint256 milestoneIndex, bytes32 evidenceHash);
    error ZeroApprovalHash();
    error ZeroRevisionReasonHash();
    error BountyNotFound(uint256 bountyId);
    error UnauthorizedActor(uint256 bountyId, address actor);
    error InvalidState(uint256 bountyId, State current, State required);
    error CancellationUnavailable(uint256 bountyId, State current);
    error DeadlineExpired(uint256 bountyId, uint64 deliveryDeadline);
    error RefundNotAvailable(uint256 bountyId, uint64 deliveryDeadline);
    error ReviewPeriodActive(uint256 bountyId, uint64 reviewDeadline);
    error RevisionAlreadyRequested(uint256 bountyId, uint256 milestoneIndex);
    error RevisionWindowClosed(uint256 bountyId, uint64 reviewDeadline);
    error SettlementUnavailable(uint256 bountyId, State current);
    error SettlementAmountExceedsPrincipal(uint256 bountyId, uint256 providerPayout, uint256 principal);
    error SettlementAcceptanceUnavailable(uint256 bountyId, address actor, address proposer);
    error SettlementProposalMismatch(uint256 bountyId, uint256 expectedProviderPayout, uint256 suppliedProviderPayout);
    error SettlementProposalExpired(uint256 bountyId, uint64 expiry);
    error SettlementProposalCancellationUnavailable(uint256 bountyId, address actor, address proposer);
    error SettlementWindowClosed(uint256 bountyId, uint64 lifecycleDeadline);
    error TermsHashMismatch(bytes32 expected, bytes32 supplied);
    error FundingAmountMismatch(address token, uint256 expected, uint256 received);
    error FundingDebitMismatch(address token, uint256 expected, uint256 debited);
    error InvalidMilestoneCount(uint256 count);
    error MilestoneArrayLengthMismatch(uint256 amountCount, uint256 deadlineCount);
    error InvalidMilestoneAmount(uint256 index, uint256 amount);
    error InvalidMilestoneDeadline(uint256 index, uint64 previousDeadline, uint64 suppliedDeadline);
    error MilestoneFundingMismatch(uint256 expected, uint256 supplied);
    error MilestoneNotFound(uint256 bountyId, uint256 milestoneIndex);
    error SettlementAmountMismatch(
        address token,
        uint256 expected,
        uint256 escrowBalanceBefore,
        uint256 escrowBalanceAfter,
        uint256 recipientBalanceBefore,
        uint256 recipientBalanceAfter
    );
    error InsolventToken(address token, uint256 balance, uint256 liability);

    event BountyCreated(
        uint256 indexed bountyId,
        address indexed requester,
        address indexed token,
        address provider,
        uint256 requestedAmount,
        bytes32 scopeHash,
        bytes32 proposalHash,
        bytes32 termsHash,
        uint64 deliveryDeadline
    );
    event BountyFunded(uint256 indexed bountyId, address indexed requester, address indexed token, uint256 amount);
    event ProviderAccepted(uint256 indexed bountyId, address indexed provider, bytes32 acceptedTermsHash);
    event DeliverySubmitted(
        uint256 indexed bountyId, address indexed provider, bytes32 evidenceHash, uint64 reviewDeadline
    );
    event BuyerApproved(uint256 indexed bountyId, address indexed requester, bytes32 approvalHash);
    event BountyReleased(uint256 indexed bountyId, address indexed provider, address indexed token, uint256 amount);
    event BountyCancelled(
        uint256 indexed bountyId, address indexed requester, address indexed token, uint256 refundedAmount
    );
    event BountyRefunded(
        uint256 indexed bountyId,
        address indexed requester,
        address indexed token,
        uint256 amount,
        uint64 deliveryDeadline
    );
    event SettlementProposed(uint256 indexed bountyId, address indexed proposer, uint256 providerPayout, uint64 expiry);
    event SettlementProposalCancelled(uint256 indexed bountyId, address indexed proposer);
    event MilestoneScheduleCreated(
        uint256 indexed bountyId, bytes32 indexed scheduleHash, uint256 milestoneCount, uint256 allocatedAmount
    );
    event MilestoneConfigured(
        uint256 indexed bountyId, uint256 indexed milestoneIndex, uint256 amount, uint64 deliveryDeadline
    );
    event MilestoneSubmitted(
        uint256 indexed bountyId,
        uint256 indexed milestoneIndex,
        address indexed provider,
        bytes32 evidenceHash,
        uint64 reviewDeadline
    );
    event MilestoneApproved(
        uint256 indexed bountyId, uint256 indexed milestoneIndex, address indexed requester, bytes32 approvalHash
    );
    event MilestoneRevisionRequested(
        uint256 indexed bountyId,
        uint256 indexed milestoneIndex,
        address indexed requester,
        bytes32 reasonHash,
        uint64 revisionDeadline
    );
    event MilestoneReleased(
        uint256 indexed bountyId,
        uint256 indexed milestoneIndex,
        address indexed provider,
        address token,
        uint256 amount,
        uint256 remainingPrincipal
    );
    event BountySettled(
        uint256 indexed bountyId,
        address indexed provider,
        address indexed requester,
        address token,
        address proposer,
        address acceptor,
        uint256 providerPayout,
        uint256 requesterRefund
    );

    function nextBountyId() external view returns (uint256);
    function totalLiability(address token) external view returns (uint256);
    function SCOPE_DOMAIN() external view returns (bytes32);
    function TERMS_DOMAIN() external view returns (bytes32);
    function EVIDENCE_DOMAIN() external view returns (bytes32);
    function APPROVAL_DOMAIN() external view returns (bytes32);
    function REVIEW_PERIOD() external view returns (uint64);
    function REVISION_PERIOD() external view returns (uint64);
    function SETTLEMENT_PROPOSAL_PERIOD() external view returns (uint64);
    function MIN_MILESTONE_SPACING() external view returns (uint64);
    function MAX_MILESTONES() external view returns (uint32);
    function MILESTONE_SCHEDULE_DOMAIN() external view returns (bytes32);
    function MILESTONE_TERMS_DOMAIN() external view returns (bytes32);

    function createBounty(
        address token,
        uint256 requestedAmount,
        uint64 deliveryDeadline,
        bytes32 scopeHash,
        address provider,
        bytes32 proposalHash
    ) external returns (uint256 bountyId);

    function createMilestoneBounty(
        address token,
        uint256 requestedAmount,
        uint256[] calldata milestoneAmounts,
        uint64[] calldata milestoneDeadlines,
        bytes32 scopeHash,
        address provider,
        bytes32 proposalHash
    ) external returns (uint256 bountyId);

    function fundBounty(uint256 bountyId, uint256 amount) external;
    function acceptBounty(uint256 bountyId, bytes32 acceptedTermsHash) external;
    /// @notice Commits canonical evidence whose offchain preimage independently binds the
    /// exact delivered-byte SHA-256 digest and URI hash. Direct callers derive this hash.
    function submitDelivery(uint256 bountyId, bytes32 evidenceHash) external;
    function approveDelivery(uint256 bountyId, bytes32 approvalHash) external;
    function requestRevision(uint256 bountyId, bytes32 reasonHash) external;
    function release(uint256 bountyId) external;
    function proposeSettlement(uint256 bountyId, uint256 providerPayout) external;
    function acceptSettlement(uint256 bountyId, uint256 providerPayout) external;
    function cancelSettlementProposal(uint256 bountyId) external;
    function cancelBounty(uint256 bountyId) external;
    function refundBounty(uint256 bountyId) external;
    function getBounty(uint256 bountyId) external view returns (Bounty memory);
    function getMilestone(uint256 bountyId, uint256 milestoneIndex) external view returns (Milestone memory);
}
