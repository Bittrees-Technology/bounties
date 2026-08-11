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
///   escrowAddress, scopeHash, proposalHash, salt))
/// - evidenceHash: keccak256(abi.encode(keccak256("BOUNTY_EVIDENCE_V1"), chainId,
///   escrowAddress, bountyId, scopeHash, termsHash, provider, contentHash, uriHash, salt))
/// - approvalHash: keccak256(abi.encode(keccak256("BOUNTY_APPROVAL_V1"), chainId,
///   escrowAddress, bountyId, evidenceHash, requester, decisionHash, salt))
/// The contract stores commitments but intentionally does not interpret their preimages.
contract BountyEscrow is IBountyEscrow, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant override SCOPE_DOMAIN = keccak256("BOUNTY_SCOPE_V1");
    bytes32 public constant override TERMS_DOMAIN = keccak256("BOUNTY_TERMS_V1");
    bytes32 public constant override EVIDENCE_DOMAIN = keccak256("BOUNTY_EVIDENCE_V1");
    bytes32 public constant override APPROVAL_DOMAIN = keccak256("BOUNTY_APPROVAL_V1");

    uint256 public override nextBountyId = 1;
    mapping(address token => uint256 liability) public override totalLiability;
    mapping(uint256 bountyId => Bounty bounty) private _bounties;

    /// @notice Creates a bounty and optionally funds it atomically.
    /// @param requestedAmount Exact ERC20 amount to pull, or zero for a record funded later.
    /// @param deliveryDeadline Zero for no timeout, otherwise the first timestamp at which an
    ///        accepted-but-undelivered bounty is refundable. Acceptance and delivery require
    ///        `block.timestamp < deliveryDeadline`; refund requires `>=`.
    /// @dev Fee-on-transfer, sender-taxed, and other inexact deposits revert.
    function createBounty(
        address token,
        uint256 requestedAmount,
        uint64 deliveryDeadline,
        bytes32 scopeHash,
        bytes32 termsHash
    ) external override nonReentrant returns (uint256 bountyId) {
        _validateCreation(token, deliveryDeadline, scopeHash, termsHash);

        bountyId = nextBountyId++;
        Bounty storage bounty = _bounties[bountyId];
        bounty.requester = msg.sender;
        bounty.token = IERC20(token);
        bounty.deliveryDeadline = deliveryDeadline;
        bounty.scopeHash = scopeHash;
        bounty.termsHash = termsHash;
        bounty.state = State.Created;

        emit BountyCreated(bountyId, msg.sender, token, requestedAmount, scopeHash, termsHash, deliveryDeadline);

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

        _pullExact(bounty.token, msg.sender, amount);
        bounty.amount = amount;
        bounty.state = State.Funded;
        totalLiability[address(bounty.token)] += amount;
        _requireSolvent(bounty.token);

        emit BountyFunded(bountyId, msg.sender, address(bounty.token), amount);
    }

    /// @notice Permissionlessly opts the caller into the committed bounty terms as provider.
    /// @dev Passing the expected hash prevents a provider from accepting stale or substituted terms.
    function acceptBounty(uint256 bountyId, bytes32 acceptedTermsHash) external override nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        _onlyState(bountyId, bounty, State.Funded);
        _requireBeforeDeadline(bountyId, bounty.deliveryDeadline);
        if (msg.sender == bounty.requester || msg.sender == address(this)) revert InvalidProvider(msg.sender);
        if (acceptedTermsHash != bounty.termsHash) {
            revert TermsHashMismatch(bounty.termsHash, acceptedTermsHash);
        }
        _requireSolvent(bounty.token);

        bounty.provider = msg.sender;
        bounty.acceptedTermsHash = acceptedTermsHash;
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

        bounty.evidenceHash = evidenceHash;
        bounty.state = State.Delivered;

        emit DeliverySubmitted(bountyId, msg.sender, evidenceHash);
    }

    /// @notice Records the requester's immutable approval commitment.
    function approveDelivery(uint256 bountyId, bytes32 approvalHash) external override nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        _onlyRequester(bountyId, bounty);
        _onlyState(bountyId, bounty, State.Delivered);
        if (approvalHash == bytes32(0)) revert ZeroApprovalHash();
        _requireSolvent(bounty.token);

        bounty.approvalHash = approvalHash;
        bounty.state = State.BuyerApproved;

        emit BuyerApproved(bountyId, msg.sender, approvalHash);
    }

    /// @notice Pays an approved bounty to its provider. Anyone may trigger the owed payment.
    function release(uint256 bountyId) external override nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        _onlyState(bountyId, bounty, State.BuyerApproved);

        IERC20 token = bounty.token;
        address provider = bounty.provider;
        uint256 amount = bounty.amount;
        _requireSolvent(token);

        bounty.amount = 0;
        bounty.state = State.Released;
        uint256 remainingLiability = totalLiability[address(token)] - amount;
        totalLiability[address(token)] = remainingLiability;

        emit BountyReleased(bountyId, provider, address(token), amount);
        _pushExact(token, provider, amount, remainingLiability);
    }

    /// @notice Cancels a bounty before any provider has accepted it.
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
        bounty.state = State.Cancelled;
        uint256 remainingLiability = totalLiability[address(token)] - amount;
        totalLiability[address(token)] = remainingLiability;

        emit BountyCancelled(bountyId, msg.sender, address(token), amount);
        if (amount != 0) _pushExact(token, msg.sender, amount, remainingLiability);
    }

    /// @notice Refunds an accepted bounty that was not delivered before its deadline.
    /// @dev The exact boundary is inclusive: `block.timestamp >= deliveryDeadline`.
    function refundBounty(uint256 bountyId) external override nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        _onlyRequester(bountyId, bounty);
        _onlyState(bountyId, bounty, State.ProviderAccepted);

        uint64 deliveryDeadline = bounty.deliveryDeadline;
        if (deliveryDeadline == 0 || block.timestamp < deliveryDeadline) {
            revert RefundNotAvailable(bountyId, deliveryDeadline);
        }

        IERC20 token = bounty.token;
        uint256 amount = bounty.amount;
        _requireSolvent(token);

        bounty.amount = 0;
        bounty.state = State.Refunded;
        uint256 remainingLiability = totalLiability[address(token)] - amount;
        totalLiability[address(token)] = remainingLiability;

        emit BountyRefunded(bountyId, msg.sender, address(token), amount, deliveryDeadline);
        _pushExact(token, msg.sender, amount, remainingLiability);
    }

    function getBounty(uint256 bountyId) external view override returns (Bounty memory) {
        return _getBounty(bountyId);
    }

    function _validateCreation(address token, uint64 deliveryDeadline, bytes32 scopeHash, bytes32 termsHash)
        private
        view
    {
        if (token == address(0)) revert ZeroAddress();
        if (token.code.length == 0) revert InvalidToken(token);
        if (deliveryDeadline != 0 && deliveryDeadline <= block.timestamp) {
            revert InvalidDeadline(deliveryDeadline);
        }
        if (scopeHash == bytes32(0)) revert ZeroScopeHash();
        if (termsHash == bytes32(0)) revert ZeroTermsHash();
    }

    function _pullExact(IERC20 token, address from, uint256 amount) private {
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        uint256 balanceAfter = token.balanceOf(address(this));
        uint256 received = balanceAfter >= balanceBefore ? balanceAfter - balanceBefore : 0;
        if (received != amount) revert FundingAmountMismatch(address(token), amount, received);
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

    function _onlyState(uint256 bountyId, Bounty storage bounty, State required) private view {
        if (bounty.state != required) revert InvalidState(bountyId, bounty.state, required);
    }

    function _requireBeforeDeadline(uint256 bountyId, uint64 deliveryDeadline) private view {
        if (deliveryDeadline != 0 && block.timestamp >= deliveryDeadline) {
            revert DeadlineExpired(bountyId, deliveryDeadline);
        }
    }
}
