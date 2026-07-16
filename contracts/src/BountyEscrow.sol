// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BountyEscrow
/// @notice Minimal, single-token-per-bounty ERC20 escrow for testnet review.
/// @dev The arbiter is trusted to choose the final payout after a dispute. Pausing only
///      blocks new liabilities; terminal payout paths remain available while paused.
contract BountyEscrow is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    enum State {
        Created,
        Funded,
        Assigned,
        Delivered,
        Accepted,
        Released,
        Refunded,
        Disputed,
        Resolved
    }

    struct Bounty {
        address requester;
        address provider;
        IERC20 token;
        uint256 amount;
        uint64 refundAvailableAt;
        State state;
    }

    error ZeroAddress();
    error InvalidToken(address token);
    error InvalidProvider(address provider);
    error InvalidDeadline(uint64 refundAvailableAt);
    error InvalidAmount(uint256 amount);
    error ZeroFundingReceived();
    error BountyNotFound(uint256 bountyId);
    error UnauthorizedActor(uint256 bountyId, address actor);
    error InvalidState(uint256 bountyId, State state);
    error RefundNotAvailable(uint256 bountyId, uint64 refundAvailableAt);
    error InvalidProviderAward(uint256 award, uint256 escrowedAmount);

    event BountyCreated(
        uint256 indexed bountyId,
        address indexed requester,
        address indexed token,
        uint256 requestedFunding,
        uint64 refundAvailableAt
    );

    event BountyStateTransition(
        uint256 indexed bountyId,
        State indexed fromState,
        State indexed toState,
        address actor,
        address token,
        address requester,
        address provider,
        uint256 escrowedAmount,
        uint256 requesterPayout,
        uint256 providerPayout
    );

    uint256 public nextBountyId = 1;
    mapping(uint256 bountyId => Bounty bounty) private _bounties;

    constructor(address admin, address arbiter, address guardian) {
        if (admin == address(0) || arbiter == address(0) || guardian == address(0)) {
            revert ZeroAddress();
        }

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ARBITER_ROLE, arbiter);
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    /// @notice Creates an unfunded bounty or atomically funds it with `requestedFunding`.
    /// @dev Fee-on-transfer deposits are recorded using the actual balance delta received.
    function createBounty(address token, uint256 requestedFunding, uint64 refundAvailableAt)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 bountyId)
    {
        if (token == address(0) || token.code.length == 0) revert InvalidToken(token);
        if (refundAvailableAt != 0 && refundAvailableAt <= block.timestamp) {
            revert InvalidDeadline(refundAvailableAt);
        }

        bountyId = nextBountyId++;
        Bounty storage bounty = _bounties[bountyId];
        bounty.requester = msg.sender;
        bounty.token = IERC20(token);
        bounty.refundAvailableAt = refundAvailableAt;
        bounty.state = State.Created;

        emit BountyCreated(bountyId, msg.sender, token, requestedFunding, refundAvailableAt);

        if (requestedFunding != 0) {
            _collectFunding(bounty, requestedFunding);
            _transition(bountyId, bounty, State.Funded, msg.sender, bounty.amount, 0, 0);
        }
    }

    /// @notice Funds a bounty that was created without funding.
    function fundBounty(uint256 bountyId, uint256 requestedFunding) external whenNotPaused nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        _onlyRequester(bountyId, bounty);
        _onlyState(bountyId, bounty, State.Created);
        if (requestedFunding == 0) revert InvalidAmount(requestedFunding);

        _collectFunding(bounty, requestedFunding);
        _transition(bountyId, bounty, State.Funded, msg.sender, bounty.amount, 0, 0);
    }

    /// @notice Assigns a funded bounty to a provider.
    function assignBounty(uint256 bountyId, address provider) external {
        Bounty storage bounty = _getBounty(bountyId);
        _onlyRequester(bountyId, bounty);
        _onlyState(bountyId, bounty, State.Funded);
        if (provider == address(0) || provider == bounty.requester) revert InvalidProvider(provider);

        bounty.provider = provider;
        _transition(bountyId, bounty, State.Assigned, msg.sender, bounty.amount, 0, 0);
    }

    /// @notice Marks assigned work as delivered. Only the assigned provider may call.
    function markDelivered(uint256 bountyId) external {
        Bounty storage bounty = _getBounty(bountyId);
        if (msg.sender != bounty.provider) revert UnauthorizedActor(bountyId, msg.sender);
        _onlyState(bountyId, bounty, State.Assigned);

        _transition(bountyId, bounty, State.Delivered, msg.sender, bounty.amount, 0, 0);
    }

    /// @notice Accepts delivered work. Payout is a separate, permissionless step.
    function acceptDelivery(uint256 bountyId) external {
        Bounty storage bounty = _getBounty(bountyId);
        _onlyRequester(bountyId, bounty);
        _onlyState(bountyId, bounty, State.Delivered);

        _transition(bountyId, bounty, State.Accepted, msg.sender, bounty.amount, 0, 0);
    }

    /// @notice Releases an accepted bounty to its provider. Anyone may trigger the owed payout.
    function release(uint256 bountyId) external nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        _onlyState(bountyId, bounty, State.Accepted);

        uint256 amount = bounty.amount;
        bounty.amount = 0;
        _transition(bountyId, bounty, State.Released, msg.sender, amount, 0, amount);
        bounty.token.safeTransfer(bounty.provider, amount);
    }

    /// @notice Cancels and refunds a bounty before assignment.
    function cancelBounty(uint256 bountyId) external nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        _onlyRequester(bountyId, bounty);
        if (bounty.state != State.Created && bounty.state != State.Funded) {
            revert InvalidState(bountyId, bounty.state);
        }

        uint256 amount = bounty.amount;
        bounty.amount = 0;
        _transition(bountyId, bounty, State.Refunded, msg.sender, amount, amount, 0);
        if (amount != 0) bounty.token.safeTransfer(bounty.requester, amount);
    }

    /// @notice Refunds an assigned bounty after its configured deadline, before delivery.
    function claimTimeoutRefund(uint256 bountyId) external nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        _onlyRequester(bountyId, bounty);
        _onlyState(bountyId, bounty, State.Assigned);

        uint64 refundAvailableAt = bounty.refundAvailableAt;
        if (refundAvailableAt == 0 || block.timestamp < refundAvailableAt) {
            revert RefundNotAvailable(bountyId, refundAvailableAt);
        }

        uint256 amount = bounty.amount;
        bounty.amount = 0;
        _transition(bountyId, bounty, State.Refunded, msg.sender, amount, amount, 0);
        bounty.token.safeTransfer(bounty.requester, amount);
    }

    /// @notice Escalates an assigned or delivered bounty to an arbiter.
    function raiseDispute(uint256 bountyId) external {
        Bounty storage bounty = _getBounty(bountyId);
        if (msg.sender != bounty.requester && msg.sender != bounty.provider) {
            revert UnauthorizedActor(bountyId, msg.sender);
        }
        if (bounty.state != State.Assigned && bounty.state != State.Delivered) {
            revert InvalidState(bountyId, bounty.state);
        }

        _transition(bountyId, bounty, State.Disputed, msg.sender, bounty.amount, 0, 0);
    }

    /// @notice Resolves a dispute with an optional split between provider and requester.
    /// @param providerAward Amount of escrow sent to the provider; the remainder is refunded.
    function resolveDispute(uint256 bountyId, uint256 providerAward) external onlyRole(ARBITER_ROLE) nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        _onlyState(bountyId, bounty, State.Disputed);

        uint256 amount = bounty.amount;
        if (providerAward > amount) revert InvalidProviderAward(providerAward, amount);
        uint256 requesterAward = amount - providerAward;

        bounty.amount = 0;
        _transition(bountyId, bounty, State.Resolved, msg.sender, amount, requesterAward, providerAward);

        if (requesterAward != 0) bounty.token.safeTransfer(bounty.requester, requesterAward);
        if (providerAward != 0) bounty.token.safeTransfer(bounty.provider, providerAward);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
    }

    function getBounty(uint256 bountyId) external view returns (Bounty memory) {
        Bounty storage bounty = _getBounty(bountyId);
        return bounty;
    }

    function _collectFunding(Bounty storage bounty, uint256 requestedFunding) private {
        if (requestedFunding == 0) revert InvalidAmount(requestedFunding);

        uint256 beforeBalance = bounty.token.balanceOf(address(this));
        bounty.token.safeTransferFrom(bounty.requester, address(this), requestedFunding);
        uint256 afterBalance = bounty.token.balanceOf(address(this));
        if (afterBalance <= beforeBalance) revert ZeroFundingReceived();

        bounty.amount = afterBalance - beforeBalance;
    }

    function _getBounty(uint256 bountyId) private view returns (Bounty storage bounty) {
        bounty = _bounties[bountyId];
        if (bounty.requester == address(0)) revert BountyNotFound(bountyId);
    }

    function _onlyRequester(uint256 bountyId, Bounty storage bounty) private view {
        if (msg.sender != bounty.requester) revert UnauthorizedActor(bountyId, msg.sender);
    }

    function _onlyState(uint256 bountyId, Bounty storage bounty, State expected) private view {
        if (bounty.state != expected) revert InvalidState(bountyId, bounty.state);
    }

    function _transition(
        uint256 bountyId,
        Bounty storage bounty,
        State nextState,
        address actor,
        uint256 escrowedAmount,
        uint256 requesterPayout,
        uint256 providerPayout
    ) private {
        State previousState = bounty.state;
        bounty.state = nextState;
        emit BountyStateTransition(
            bountyId,
            previousState,
            nextState,
            actor,
            address(bounty.token),
            bounty.requester,
            bounty.provider,
            escrowedAmount,
            requesterPayout,
            providerPayout
        );
    }
}

