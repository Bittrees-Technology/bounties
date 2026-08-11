// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

import {BountyEscrow} from "../src/BountyEscrow.sol";
import {IBountyEscrow} from "../src/IBountyEscrow.sol";
import {FalseReturnERC20} from "./mocks/FalseReturnERC20.sol";
import {FeeOnTransferERC20} from "./mocks/FeeOnTransferERC20.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {RecipientBlockingERC20} from "./mocks/RecipientBlockingERC20.sol";
import {RebasingERC20} from "./mocks/RebasingERC20.sol";
import {ReentrantERC20} from "./mocks/ReentrantERC20.sol";
import {SenderTaxERC20} from "./mocks/SenderTaxERC20.sol";

contract MockERC1271Provider is IERC1271 {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4 magicValue) {
        return IERC1271.isValidSignature.selector;
    }

    function acceptBounty(IBountyEscrow escrow, uint256 bountyId, bytes32 termsHash) external {
        escrow.acceptBounty(bountyId, termsHash);
    }
}

contract BountyEscrowTest is Test {
    BountyEscrow internal escrow;
    MockERC20 internal token;
    uint256 internal constant INITIAL_MINT = type(uint128).max;

    address internal requester = makeAddr("requester");
    address internal provider = makeAddr("provider");
    address internal stranger = makeAddr("stranger");
    address internal alternateProvider = makeAddr("alternate-provider");

    bytes32 internal constant METADATA_HASH = keccak256("metadata");
    bytes32 internal constant PROPOSAL_HASH = keccak256("proposal");
    bytes32 internal constant EVIDENCE_CONTENT_HASH = keccak256("evidence-content");
    bytes32 internal constant EVIDENCE_URI_HASH = keccak256("evidence-uri");
    bytes32 internal constant APPROVAL_DECISION_HASH = keccak256("approval-decision");

    function setUp() public {
        escrow = new BountyEscrow();
        token = new MockERC20();
        token.mint(requester, type(uint128).max);
        vm.prank(requester);
        token.approve(address(escrow), type(uint256).max);
    }

    function testCreateBountyStoresCommitmentsAndFundsAtomically() public {
        uint256 amount = 1_000 ether;
        uint64 deadline = uint64(block.timestamp + 3 days);
        bytes32 scopeHash = _scopeHash(amount, deadline, METADATA_HASH, bytes32(uint256(1)));
        bytes32 termsHash = _termsHash(scopeHash, PROPOSAL_HASH, provider);

        vm.expectEmit(true, true, true, true);
        emit IBountyEscrow.BountyCreated(
            1, requester, address(token), provider, amount, scopeHash, PROPOSAL_HASH, termsHash, deadline
        );
        vm.expectEmit(true, true, true, true);
        emit IBountyEscrow.BountyFunded(1, requester, address(token), amount);

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);

        assertEq(bountyId, 1);
        assertEq(escrow.nextBountyId(), 2);
        assertEq(escrow.totalLiability(address(token)), amount);

        BountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        assertEq(bounty.requester, requester);
        assertEq(bounty.provider, provider);
        assertEq(address(bounty.token), address(token));
        assertEq(bounty.amount, amount);
        assertEq(bounty.deliveryDeadline, deadline);
        assertEq(bounty.reviewDeadline, 0);
        assertEq(uint256(bounty.state), uint256(IBountyEscrow.State.Funded));
        assertEq(bounty.scopeHash, scopeHash);
        assertEq(bounty.proposalHash, PROPOSAL_HASH);
        assertEq(bounty.termsHash, termsHash);
        assertEq(bounty.acceptedTermsHash, bytes32(0));
        assertEq(bounty.evidenceHash, bytes32(0));
        assertEq(bounty.approvalHash, bytes32(0));
        assertEq(bounty.settlementProposer, address(0));
        assertEq(bounty.proposedProviderPayout, 0);
    }

    function testCreateBountyAllowsUnfundedRecordAndLaterFunding() public {
        uint256 amount = 375 ether;
        uint64 deadline = uint64(block.timestamp + 5 days);
        bytes32 scopeHash = _scopeHash(amount, deadline, METADATA_HASH, bytes32(uint256(3)));
        bytes32 termsHash = _termsHash(scopeHash, PROPOSAL_HASH, provider);

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), 0, deadline, scopeHash, provider, PROPOSAL_HASH);

        BountyEscrow.Bounty memory created = escrow.getBounty(bountyId);
        assertEq(uint256(created.state), uint256(IBountyEscrow.State.Created));
        assertEq(created.amount, 0);
        assertEq(created.provider, provider);
        assertEq(created.proposalHash, PROPOSAL_HASH);
        assertEq(created.termsHash, termsHash);
        assertEq(escrow.totalLiability(address(token)), 0);

        vm.expectEmit(true, true, true, true);
        emit IBountyEscrow.BountyFunded(bountyId, requester, address(token), amount);

        vm.prank(requester);
        escrow.fundBounty(bountyId, amount);

        BountyEscrow.Bounty memory funded = escrow.getBounty(bountyId);
        assertEq(uint256(funded.state), uint256(IBountyEscrow.State.Funded));
        assertEq(funded.amount, amount);
        assertEq(escrow.totalLiability(address(token)), amount);
    }

    function testCreateBountyRejectsInvalidInputs() public {
        uint64 futureDeadline = uint64(block.timestamp + 1 days);
        bytes32 scopeHash = bytes32(uint256(1));
        bytes32 proposalHash = bytes32(uint256(2));

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.ZeroAddress.selector));
        vm.prank(requester);
        escrow.createBounty(address(0), 1, futureDeadline, scopeHash, provider, proposalHash);

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.InvalidToken.selector, address(requester)));
        vm.prank(requester);
        escrow.createBounty(address(requester), 1, futureDeadline, scopeHash, provider, proposalHash);

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.InvalidDeadline.selector, uint64(block.timestamp)));
        vm.prank(requester);
        escrow.createBounty(address(token), 1, uint64(block.timestamp), scopeHash, provider, proposalHash);

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.ZeroScopeHash.selector));
        vm.prank(requester);
        escrow.createBounty(address(token), 1, futureDeadline, bytes32(0), provider, proposalHash);

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.InvalidProvider.selector, address(0)));
        vm.prank(requester);
        escrow.createBounty(address(token), 1, futureDeadline, scopeHash, address(0), proposalHash);

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.InvalidProvider.selector, requester));
        vm.prank(requester);
        escrow.createBounty(address(token), 1, futureDeadline, scopeHash, requester, proposalHash);

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.InvalidProvider.selector, address(escrow)));
        vm.prank(requester);
        escrow.createBounty(address(token), 1, futureDeadline, scopeHash, address(escrow), proposalHash);

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), 0, futureDeadline, scopeHash, provider, proposalHash);
        assertEq(bountyId, 1);
    }

    function testCreateBountyRejectsZeroProposalHash() public {
        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.ZeroProposalHash.selector));
        vm.prank(requester);
        escrow.createBounty(address(token), 0, 0, bytes32(uint256(1)), provider, bytes32(0));
    }

    function testCreateAndAcceptBountyAllowsSmartContractProvider() public {
        uint256 amount = 100 ether;
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 scopeHash = _scopeHash(amount, deadline, METADATA_HASH, bytes32(uint256(4)));
        MockERC1271Provider contractProvider = new MockERC1271Provider();
        bytes32 termsHash = _termsHash(scopeHash, PROPOSAL_HASH, address(contractProvider));

        vm.prank(requester);
        uint256 bountyId =
            escrow.createBounty(address(token), amount, deadline, scopeHash, address(contractProvider), PROPOSAL_HASH);

        IBountyEscrow.Bounty memory created = escrow.getBounty(bountyId);
        assertEq(created.provider, address(contractProvider));
        assertGt(address(contractProvider).code.length, 0);

        contractProvider.acceptBounty(escrow, bountyId, termsHash);

        IBountyEscrow.Bounty memory accepted = escrow.getBounty(bountyId);
        assertEq(uint256(accepted.state), uint256(IBountyEscrow.State.ProviderAccepted));
        assertEq(accepted.acceptedTermsHash, termsHash);
    }

    function testFundBountyAuthorizationAmountAndDeadlineChecks() public {
        uint64 deadline = uint64(block.timestamp + 2 days);
        bytes32 scopeHash = _scopeHash(AMOUNT(), deadline, METADATA_HASH, bytes32(uint256(5)));

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), 0, deadline, scopeHash, provider, PROPOSAL_HASH);

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.UnauthorizedActor.selector, bountyId, stranger));
        vm.prank(stranger);
        escrow.fundBounty(bountyId, 1 ether);

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.InvalidAmount.selector, 0));
        vm.prank(requester);
        escrow.fundBounty(bountyId, 0);

        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.DeadlineExpired.selector, bountyId, deadline));
        vm.prank(requester);
        escrow.fundBounty(bountyId, 1 ether);
    }

    function testFundedRecordCanBeAcceptedDeliveredApprovedAndReleased() public {
        uint256 amount = 2_000 ether;
        uint64 deadline = uint64(block.timestamp + 4 days);
        bytes32 scopeHash = _scopeHash(amount, deadline, METADATA_HASH, bytes32(uint256(7)));
        bytes32 termsHash = _termsHash(scopeHash, PROPOSAL_HASH, provider);

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);

        vm.expectRevert(
            abi.encodeWithSelector(IBountyEscrow.TermsHashMismatch.selector, termsHash, bytes32(uint256(9)))
        );
        vm.prank(provider);
        escrow.acceptBounty(bountyId, bytes32(uint256(9)));

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.InvalidProvider.selector, stranger));
        vm.prank(stranger);
        escrow.acceptBounty(bountyId, termsHash);

        vm.expectEmit(true, true, true, true);
        emit IBountyEscrow.ProviderAccepted(bountyId, provider, termsHash);
        vm.prank(provider);
        escrow.acceptBounty(bountyId, termsHash);

        BountyEscrow.Bounty memory accepted = escrow.getBounty(bountyId);
        assertEq(accepted.provider, provider);
        assertEq(accepted.proposalHash, PROPOSAL_HASH);
        assertEq(accepted.termsHash, termsHash);

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.UnauthorizedActor.selector, bountyId, stranger));
        vm.prank(stranger);
        escrow.submitDelivery(bountyId, bytes32(uint256(10)));

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.ZeroEvidenceHash.selector));
        vm.prank(provider);
        escrow.submitDelivery(bountyId, bytes32(0));

        bytes32 evidenceHash = _evidenceHash(
            bountyId, scopeHash, termsHash, provider, EVIDENCE_CONTENT_HASH, EVIDENCE_URI_HASH, bytes32(uint256(11))
        );
        uint64 reviewDeadline = uint64(block.timestamp) + escrow.REVIEW_PERIOD();
        vm.expectEmit(true, true, true, true);
        emit IBountyEscrow.DeliverySubmitted(bountyId, provider, evidenceHash, reviewDeadline);
        vm.prank(provider);
        escrow.submitDelivery(bountyId, evidenceHash);

        BountyEscrow.Bounty memory delivered = escrow.getBounty(bountyId);
        assertEq(delivered.reviewDeadline, reviewDeadline);

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.UnauthorizedActor.selector, bountyId, stranger));
        vm.prank(stranger);
        escrow.approveDelivery(bountyId, bytes32(uint256(12)));

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.ZeroApprovalHash.selector));
        vm.prank(requester);
        escrow.approveDelivery(bountyId, bytes32(0));

        bytes32 approvalHash =
            _approvalHash(bountyId, evidenceHash, requester, APPROVAL_DECISION_HASH, bytes32(uint256(13)));
        vm.expectEmit(true, true, true, true);
        emit IBountyEscrow.BuyerApproved(bountyId, requester, approvalHash);
        vm.prank(requester);
        escrow.approveDelivery(bountyId, approvalHash);

        vm.expectEmit(true, true, true, true);
        emit IBountyEscrow.BountyReleased(bountyId, provider, address(token), amount);
        vm.prank(stranger);
        escrow.release(bountyId);

        BountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        assertEq(uint256(bounty.state), uint256(IBountyEscrow.State.Released));
        assertEq(bounty.amount, 0);
        assertEq(token.balanceOf(provider), amount);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalLiability(address(token)), 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                IBountyEscrow.InvalidState.selector,
                bountyId,
                IBountyEscrow.State.Released,
                IBountyEscrow.State.BuyerApproved
            )
        );
        escrow.release(bountyId);
    }

    function testSevenDayReviewBlocksEarlyReleaseAndAllowsAnyoneAtExactBoundary() public {
        uint256 amount = 1_250 ether;
        uint64 deadline = uint64(block.timestamp + 2 days);
        bytes32 scopeHash = _scopeHash(amount, deadline, METADATA_HASH, bytes32(uint256(101)));
        bytes32 termsHash = _termsHash(scopeHash, PROPOSAL_HASH, provider);

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);
        vm.prank(provider);
        escrow.acceptBounty(bountyId, termsHash);
        vm.prank(provider);
        escrow.submitDelivery(bountyId, keccak256("review-evidence"));

        uint64 reviewDeadline = uint64(block.timestamp) + 7 days;
        BountyEscrow.Bounty memory delivered = escrow.getBounty(bountyId);
        assertEq(escrow.REVIEW_PERIOD(), 7 days);
        assertEq(delivered.reviewDeadline, reviewDeadline);

        vm.warp(reviewDeadline - 1);
        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.ReviewPeriodActive.selector, bountyId, reviewDeadline));
        vm.prank(stranger);
        escrow.release(bountyId);

        vm.warp(reviewDeadline);
        vm.expectEmit(true, true, true, true);
        emit IBountyEscrow.BountyReleased(bountyId, provider, address(token), amount);
        vm.prank(stranger);
        escrow.release(bountyId);

        BountyEscrow.Bounty memory released = escrow.getBounty(bountyId);
        assertEq(uint256(released.state), uint256(IBountyEscrow.State.Released));
        assertEq(released.amount, 0);
        assertEq(token.balanceOf(provider), amount);
        assertEq(escrow.totalLiability(address(token)), 0);
    }

    function testEitherPartyCanProposeAndCounterpartyCanAtomicallySettle() public {
        uint256 amount = 1_000 ether;
        uint64 deadline = uint64(block.timestamp + 2 days);
        bytes32 scopeHash = _scopeHash(amount, deadline, METADATA_HASH, bytes32(uint256(102)));

        vm.prank(requester);
        uint256 buyerProposedId =
            escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);
        uint256 providerPayout = 400 ether;
        uint256 requesterRefund = amount - providerPayout;

        vm.expectEmit(true, true, false, true);
        emit IBountyEscrow.SettlementProposed(buyerProposedId, requester, providerPayout);
        vm.prank(requester);
        escrow.proposeSettlement(buyerProposedId, providerPayout);

        vm.expectEmit(true, true, true, true);
        emit IBountyEscrow.BountySettled(
            buyerProposedId, provider, requester, address(token), requester, provider, providerPayout, requesterRefund
        );
        vm.prank(provider);
        escrow.acceptSettlement(buyerProposedId, providerPayout);

        BountyEscrow.Bounty memory first = escrow.getBounty(buyerProposedId);
        assertEq(uint256(first.state), uint256(IBountyEscrow.State.Settled));
        assertEq(first.amount, 0);
        assertEq(token.balanceOf(provider), providerPayout);
        assertEq(escrow.totalLiability(address(token)), 0);

        vm.prank(requester);
        uint256 providerProposedId =
            escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);
        bytes32 termsHash = _termsHash(scopeHash, PROPOSAL_HASH, provider);
        vm.prank(provider);
        escrow.acceptBounty(providerProposedId, termsHash);
        vm.prank(provider);
        escrow.submitDelivery(providerProposedId, keccak256("settled-delivery"));
        uint256 secondProviderPayout = 275 ether;
        vm.prank(provider);
        escrow.proposeSettlement(providerProposedId, secondProviderPayout);
        vm.prank(requester);
        escrow.acceptSettlement(providerProposedId, secondProviderPayout);

        BountyEscrow.Bounty memory second = escrow.getBounty(providerProposedId);
        assertEq(uint256(second.state), uint256(IBountyEscrow.State.Settled));
        assertEq(token.balanceOf(provider), providerPayout + secondProviderPayout);
        assertEq(token.balanceOf(requester), INITIAL_MINT - providerPayout - secondProviderPayout);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalLiability(address(token)), 0);
    }

    function testSettlementRejectsUnauthorizedStaleOversizedAndSelfAcceptedProposals() public {
        uint256 amount = 800 ether;
        uint64 deadline = uint64(block.timestamp + 2 days);
        bytes32 scopeHash = _scopeHash(amount, deadline, METADATA_HASH, bytes32(uint256(103)));

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.UnauthorizedActor.selector, bountyId, stranger));
        vm.prank(stranger);
        escrow.proposeSettlement(bountyId, 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                IBountyEscrow.SettlementAmountExceedsPrincipal.selector, bountyId, amount + 1, amount
            )
        );
        vm.prank(requester);
        escrow.proposeSettlement(bountyId, amount + 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                IBountyEscrow.SettlementAcceptanceUnavailable.selector, bountyId, provider, address(0)
            )
        );
        vm.prank(provider);
        escrow.acceptSettlement(bountyId, 0);

        vm.prank(requester);
        escrow.proposeSettlement(bountyId, 300 ether);

        vm.expectRevert(
            abi.encodeWithSelector(
                IBountyEscrow.SettlementAcceptanceUnavailable.selector, bountyId, requester, requester
            )
        );
        vm.prank(requester);
        escrow.acceptSettlement(bountyId, 300 ether);

        vm.expectRevert(
            abi.encodeWithSelector(IBountyEscrow.SettlementProposalMismatch.selector, bountyId, 300 ether, 301 ether)
        );
        vm.prank(provider);
        escrow.acceptSettlement(bountyId, 301 ether);

        vm.prank(provider);
        escrow.proposeSettlement(bountyId, 450 ether);
        vm.prank(requester);
        escrow.acceptSettlement(bountyId, 450 ether);

        vm.expectRevert(
            abi.encodeWithSelector(IBountyEscrow.SettlementUnavailable.selector, bountyId, IBountyEscrow.State.Settled)
        );
        vm.prank(provider);
        escrow.acceptSettlement(bountyId, 450 ether);
    }

    function testSettlementProposalIsInvalidatedByAcceptanceAndDelivery() public {
        uint256 amount = 800 ether;
        uint64 deadline = uint64(block.timestamp + 2 days);
        bytes32 scopeHash = _scopeHash(amount, deadline, METADATA_HASH, bytes32(uint256(106)));
        bytes32 termsHash = _termsHash(scopeHash, PROPOSAL_HASH, provider);

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);
        vm.prank(requester);
        escrow.proposeSettlement(bountyId, 0);

        vm.prank(provider);
        escrow.acceptBounty(bountyId, termsHash);

        BountyEscrow.Bounty memory accepted = escrow.getBounty(bountyId);
        assertEq(accepted.settlementProposer, address(0));
        assertEq(accepted.proposedProviderPayout, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IBountyEscrow.SettlementAcceptanceUnavailable.selector, bountyId, requester, address(0)
            )
        );
        vm.prank(requester);
        escrow.acceptSettlement(bountyId, 0);

        vm.prank(provider);
        escrow.proposeSettlement(bountyId, 300 ether);
        vm.prank(provider);
        escrow.submitDelivery(bountyId, keccak256("invalidation-delivery"));

        BountyEscrow.Bounty memory delivered = escrow.getBounty(bountyId);
        assertEq(delivered.settlementProposer, address(0));
        assertEq(delivered.proposedProviderPayout, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IBountyEscrow.SettlementAcceptanceUnavailable.selector, bountyId, requester, address(0)
            )
        );
        vm.prank(requester);
        escrow.acceptSettlement(bountyId, 0);
    }

    function testSettlementReentrancyCallbackIsRejectedAndSplitStillSucceeds() public {
        ReentrantERC20 reentrantToken = new ReentrantERC20();
        uint256 amount = 1_000 ether;
        uint256 providerPayout = 350 ether;
        reentrantToken.mint(requester, amount);
        vm.prank(requester);
        reentrantToken.approve(address(escrow), amount);

        vm.prank(requester);
        uint256 bountyId =
            escrow.createBounty(address(reentrantToken), amount, 0, bytes32(uint256(104)), provider, PROPOSAL_HASH);
        vm.prank(requester);
        escrow.proposeSettlement(bountyId, providerPayout);

        reentrantToken.resetFlags();
        reentrantToken.armSettlement(escrow, bountyId, providerPayout);
        vm.prank(provider);
        escrow.acceptSettlement(bountyId, providerPayout);

        assertEq(reentrantToken.reentryAttempted(), true);
        assertEq(reentrantToken.reentrySucceeded(), false);
        assertEq(reentrantToken.balanceOf(provider), providerPayout);
        assertEq(reentrantToken.balanceOf(requester), amount - providerPayout);
        assertEq(escrow.totalLiability(address(reentrantToken)), 0);
    }

    function testSettlementRefundFailureAtomicallyRollsBackProviderPaymentAndState() public {
        RecipientBlockingERC20 blockingToken = new RecipientBlockingERC20();
        uint256 amount = 1_000 ether;
        uint256 providerPayout = 350 ether;
        blockingToken.mint(requester, amount);
        vm.prank(requester);
        blockingToken.approve(address(escrow), amount);

        vm.prank(requester);
        uint256 bountyId =
            escrow.createBounty(address(blockingToken), amount, 0, bytes32(uint256(105)), provider, PROPOSAL_HASH);
        vm.prank(requester);
        escrow.proposeSettlement(bountyId, providerPayout);

        blockingToken.setBlockedRecipient(requester, true);
        vm.expectRevert(abi.encodeWithSelector(RecipientBlockingERC20.RecipientBlocked.selector, requester));
        vm.prank(provider);
        escrow.acceptSettlement(bountyId, providerPayout);

        BountyEscrow.Bounty memory unchanged = escrow.getBounty(bountyId);
        assertEq(uint256(unchanged.state), uint256(IBountyEscrow.State.Funded));
        assertEq(unchanged.amount, amount);
        assertEq(escrow.totalLiability(address(blockingToken)), amount);
        assertEq(blockingToken.balanceOf(address(escrow)), amount);
        assertEq(blockingToken.balanceOf(provider), 0);
        assertEq(blockingToken.balanceOf(requester), 0);

        blockingToken.setBlockedRecipient(requester, false);
        vm.prank(provider);
        escrow.acceptSettlement(bountyId, providerPayout);

        BountyEscrow.Bounty memory settled = escrow.getBounty(bountyId);
        assertEq(uint256(settled.state), uint256(IBountyEscrow.State.Settled));
        assertEq(blockingToken.balanceOf(provider), providerPayout);
        assertEq(blockingToken.balanceOf(requester), amount - providerPayout);
        assertEq(escrow.totalLiability(address(blockingToken)), 0);
    }

    function testCancellationRefundsBeforeAcceptanceAndBlocksAfterAcceptance() public {
        uint256 amount = 750 ether;
        uint64 deadline = uint64(block.timestamp + 2 days);
        bytes32 scopeHash = _scopeHash(amount, deadline, METADATA_HASH, bytes32(uint256(14)));
        bytes32 termsHash = _termsHash(scopeHash, PROPOSAL_HASH, provider);

        vm.prank(requester);
        uint256 createdId = escrow.createBounty(address(token), 0, deadline, scopeHash, provider, PROPOSAL_HASH);

        vm.expectEmit(true, true, true, true);
        emit IBountyEscrow.BountyCancelled(createdId, requester, address(token), 0);
        vm.prank(requester);
        escrow.cancelBounty(createdId);

        BountyEscrow.Bounty memory cancelled = escrow.getBounty(createdId);
        assertEq(uint256(cancelled.state), uint256(IBountyEscrow.State.Cancelled));
        assertEq(cancelled.amount, 0);
        assertEq(cancelled.provider, provider);
        assertEq(cancelled.proposalHash, PROPOSAL_HASH);

        vm.prank(requester);
        uint256 fundedId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);
        uint256 requesterBefore = token.balanceOf(requester);

        vm.expectEmit(true, true, true, true);
        emit IBountyEscrow.BountyCancelled(fundedId, requester, address(token), amount);
        vm.prank(requester);
        escrow.cancelBounty(fundedId);

        assertEq(token.balanceOf(requester), requesterBefore + amount);
        assertEq(escrow.totalLiability(address(token)), 0);

        vm.prank(requester);
        uint256 acceptedId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);
        vm.prank(provider);
        escrow.acceptBounty(acceptedId, termsHash);

        vm.expectRevert(
            abi.encodeWithSelector(
                IBountyEscrow.CancellationUnavailable.selector, acceptedId, IBountyEscrow.State.ProviderAccepted
            )
        );
        vm.prank(requester);
        escrow.cancelBounty(acceptedId);
    }

    function testRefundRequiresDeadlineAndIsAllowedExactlyAtBoundary() public {
        uint256 amount = 600 ether;
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 scopeHash = _scopeHash(amount, deadline, METADATA_HASH, bytes32(uint256(16)));
        bytes32 termsHash = _termsHash(scopeHash, PROPOSAL_HASH, provider);

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);
        vm.prank(provider);
        escrow.acceptBounty(bountyId, termsHash);

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.RefundNotAvailable.selector, bountyId, deadline));
        vm.prank(requester);
        escrow.refundBounty(bountyId);

        vm.warp(deadline);

        vm.expectEmit(true, true, true, true);
        emit IBountyEscrow.BountyRefunded(bountyId, requester, address(token), amount, deadline);
        vm.prank(requester);
        escrow.refundBounty(bountyId);

        assertEq(escrow.totalLiability(address(token)), 0);
        assertEq(token.balanceOf(requester), INITIAL_MINT);

        vm.expectRevert(
            abi.encodeWithSelector(
                IBountyEscrow.InvalidState.selector,
                bountyId,
                IBountyEscrow.State.Refunded,
                IBountyEscrow.State.ProviderAccepted
            )
        );
        vm.prank(requester);
        escrow.refundBounty(bountyId);
    }

    function testTimestampBoundariesRejectAcceptanceAndDeliveryAtDeadline() public {
        uint256 amount = 500 ether;
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 scopeHash = _scopeHash(amount, deadline, METADATA_HASH, bytes32(uint256(18)));
        bytes32 termsHash = _termsHash(scopeHash, PROPOSAL_HASH, provider);

        vm.prank(requester);
        uint256 acceptedId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);
        vm.warp(deadline);

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.DeadlineExpired.selector, acceptedId, deadline));
        vm.prank(provider);
        escrow.acceptBounty(acceptedId, termsHash);

        vm.prank(requester);
        uint256 deliveredId =
            escrow.createBounty(address(token), amount, deadline + 1 days, scopeHash, provider, PROPOSAL_HASH);
        vm.prank(provider);
        escrow.acceptBounty(deliveredId, termsHash);
        vm.warp(deadline + 1 days);

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.DeadlineExpired.selector, deliveredId, deadline + 1 days));
        vm.prank(provider);
        escrow.submitDelivery(deliveredId, keccak256("late-evidence"));
    }

    function testReplayAndDoubleSettlementAttemptsRevert() public {
        uint256 amount = 900 ether;
        uint64 deadline = uint64(block.timestamp + 3 days);
        bytes32 scopeHash = _scopeHash(amount, deadline, METADATA_HASH, bytes32(uint256(20)));
        bytes32 termsHash = _termsHash(scopeHash, PROPOSAL_HASH, provider);

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);
        vm.prank(provider);
        escrow.acceptBounty(bountyId, termsHash);
        bytes32 evidenceHash = _evidenceHash(
            bountyId, scopeHash, termsHash, provider, EVIDENCE_CONTENT_HASH, EVIDENCE_URI_HASH, bytes32(uint256(22))
        );
        bytes32 approvalHash =
            _approvalHash(bountyId, evidenceHash, requester, APPROVAL_DECISION_HASH, bytes32(uint256(23)));
        vm.prank(provider);
        escrow.submitDelivery(bountyId, evidenceHash);
        vm.prank(requester);
        escrow.approveDelivery(bountyId, approvalHash);

        escrow.release(bountyId);

        vm.expectRevert(
            abi.encodeWithSelector(
                IBountyEscrow.InvalidState.selector,
                bountyId,
                IBountyEscrow.State.Released,
                IBountyEscrow.State.BuyerApproved
            )
        );
        escrow.release(bountyId);

        vm.expectRevert(
            abi.encodeWithSelector(
                IBountyEscrow.CancellationUnavailable.selector, bountyId, IBountyEscrow.State.Released
            )
        );
        vm.prank(requester);
        escrow.cancelBounty(bountyId);
    }

    function testDirectERC20TransfersDoNotCreditLiability() public {
        uint256 amount = 333 ether;
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 scopeHash = _scopeHash(amount, deadline, METADATA_HASH, bytes32(uint256(24)));
        bytes32 termsHash = _termsHash(scopeHash, PROPOSAL_HASH, provider);

        vm.prank(requester);
        token.transfer(address(escrow), 17 ether);
        assertEq(escrow.totalLiability(address(token)), 0);
        assertEq(token.balanceOf(address(escrow)), 17 ether);

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);
        assertEq(escrow.totalLiability(address(token)), amount);
        assertEq(token.balanceOf(address(escrow)), amount + 17 ether);

        vm.prank(provider);
        escrow.acceptBounty(bountyId, termsHash);
        bytes32 evidenceHash = _evidenceHash(
            bountyId, scopeHash, termsHash, provider, EVIDENCE_CONTENT_HASH, EVIDENCE_URI_HASH, bytes32(uint256(26))
        );
        bytes32 approvalHash =
            _approvalHash(bountyId, evidenceHash, requester, APPROVAL_DECISION_HASH, bytes32(uint256(27)));
        vm.prank(provider);
        escrow.submitDelivery(bountyId, evidenceHash);
        vm.prank(requester);
        escrow.approveDelivery(bountyId, approvalHash);
        escrow.release(bountyId);

        assertEq(token.balanceOf(provider), amount);
        assertEq(token.balanceOf(address(escrow)), 17 ether);
        assertEq(escrow.totalLiability(address(token)), 0);
    }

    function testReentrancyCallbacksAreRejectedAndOuterCallStillSucceeds() public {
        ReentrantERC20 reentrantToken = new ReentrantERC20();
        reentrantToken.mint(requester, 2_000 ether);
        vm.prank(requester);
        reentrantToken.approve(address(escrow), type(uint256).max);

        uint256 amount = 1_000 ether;
        uint64 deadline = uint64(block.timestamp + 4 days);
        bytes32 scopeHash = _scopeHash(amount, deadline, METADATA_HASH, bytes32(uint256(28)));
        bytes32 termsHash = _termsHash(scopeHash, PROPOSAL_HASH, provider);

        reentrantToken.resetFlags();
        reentrantToken.armCreate(escrow, scopeHash, provider, PROPOSAL_HASH);
        vm.prank(requester);
        uint256 bountyId =
            escrow.createBounty(address(reentrantToken), amount, deadline, scopeHash, provider, PROPOSAL_HASH);
        assertEq(reentrantToken.reentryAttempted(), true);
        assertEq(reentrantToken.reentrySucceeded(), false);
        assertEq(escrow.totalLiability(address(reentrantToken)), amount);

        vm.prank(provider);
        escrow.acceptBounty(bountyId, termsHash);
        bytes32 evidenceHash = _evidenceHash(
            bountyId, scopeHash, termsHash, provider, EVIDENCE_CONTENT_HASH, EVIDENCE_URI_HASH, bytes32(uint256(30))
        );
        bytes32 approvalHash =
            _approvalHash(bountyId, evidenceHash, requester, APPROVAL_DECISION_HASH, bytes32(uint256(31)));
        vm.prank(provider);
        escrow.submitDelivery(bountyId, evidenceHash);
        vm.prank(requester);
        escrow.approveDelivery(bountyId, approvalHash);

        reentrantToken.resetFlags();
        reentrantToken.armRelease(escrow, bountyId);
        escrow.release(bountyId);
        assertEq(reentrantToken.reentryAttempted(), true);
        assertEq(reentrantToken.reentrySucceeded(), false);
        assertEq(reentrantToken.balanceOf(provider), amount);
    }

    function testFalseReturnFeeAndRebaseTokensFailClosed() public {
        uint256 amount = 250 ether;
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 scopeHash = _scopeHash(amount, deadline, METADATA_HASH, bytes32(uint256(32)));
        bytes32 termsHash = _termsHash(scopeHash, PROPOSAL_HASH, provider);

        FalseReturnERC20 falseToken = new FalseReturnERC20();
        falseToken.mint(requester, amount);
        vm.prank(requester);
        falseToken.approve(address(escrow), amount);
        vm.expectRevert(abi.encodeWithSignature("SafeERC20FailedOperation(address)", address(falseToken)));
        vm.prank(requester);
        escrow.createBounty(address(falseToken), amount, deadline, scopeHash, provider, PROPOSAL_HASH);

        vm.prank(requester);
        uint256 laterFalseId = escrow.createBounty(address(falseToken), 0, deadline, scopeHash, provider, PROPOSAL_HASH);
        vm.expectRevert(abi.encodeWithSignature("SafeERC20FailedOperation(address)", address(falseToken)));
        vm.prank(requester);
        escrow.fundBounty(laterFalseId, amount);

        FeeOnTransferERC20 feeToken = new FeeOnTransferERC20();
        feeToken.mint(requester, amount);
        vm.prank(requester);
        feeToken.approve(address(escrow), amount);
        vm.expectRevert(
            abi.encodeWithSelector(
                IBountyEscrow.FundingAmountMismatch.selector, address(feeToken), amount, amount - (amount / 100)
            )
        );
        vm.prank(requester);
        escrow.createBounty(address(feeToken), amount, deadline, scopeHash, provider, PROPOSAL_HASH);

        SenderTaxERC20 senderTaxToken = new SenderTaxERC20();
        uint256 senderTax = amount / 100;
        senderTaxToken.mint(requester, amount + senderTax);
        vm.prank(requester);
        senderTaxToken.approve(address(escrow), amount);
        vm.expectRevert(
            abi.encodeWithSelector(
                IBountyEscrow.FundingDebitMismatch.selector, address(senderTaxToken), amount, amount + senderTax
            )
        );
        vm.prank(requester);
        escrow.createBounty(address(senderTaxToken), amount, deadline, scopeHash, provider, PROPOSAL_HASH);

        RebasingERC20 rebasingToken = new RebasingERC20();
        rebasingToken.mint(requester, amount);
        vm.prank(requester);
        rebasingToken.approve(address(escrow), amount);
        vm.prank(requester);
        uint256 bountyId =
            escrow.createBounty(address(rebasingToken), amount, deadline, scopeHash, provider, PROPOSAL_HASH);
        rebasingToken.slash(address(escrow), 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                IBountyEscrow.InsolventToken.selector, address(rebasingToken), amount - 1 ether, amount
            )
        );
        vm.prank(provider);
        escrow.acceptBounty(bountyId, termsHash);
    }

    function testRebasingTokenReleaseFailsAfterPostApprovalSlash() public {
        uint256 amount = 250 ether;
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 scopeHash = _scopeHash(amount, deadline, METADATA_HASH, bytes32(uint256(38)));
        bytes32 termsHash = _termsHash(scopeHash, PROPOSAL_HASH, provider);

        RebasingERC20 rebasingToken = new RebasingERC20();
        rebasingToken.mint(requester, amount);
        vm.prank(requester);
        rebasingToken.approve(address(escrow), amount);
        vm.prank(requester);
        uint256 bountyId =
            escrow.createBounty(address(rebasingToken), amount, deadline, scopeHash, provider, PROPOSAL_HASH);
        vm.prank(provider);
        escrow.acceptBounty(bountyId, termsHash);

        bytes32 evidenceHash = _evidenceHash(
            bountyId, scopeHash, termsHash, provider, EVIDENCE_CONTENT_HASH, EVIDENCE_URI_HASH, bytes32(uint256(40))
        );
        bytes32 approvalHash =
            _approvalHash(bountyId, evidenceHash, requester, APPROVAL_DECISION_HASH, bytes32(uint256(41)));
        vm.prank(provider);
        escrow.submitDelivery(bountyId, evidenceHash);
        vm.prank(requester);
        escrow.approveDelivery(bountyId, approvalHash);

        rebasingToken.slash(address(escrow), 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                IBountyEscrow.InsolventToken.selector, address(rebasingToken), amount - 1 ether, amount
            )
        );
        escrow.release(bountyId);
    }

    function testGetBountyAndMissingBountyChecks() public {
        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.BountyNotFound.selector, 1));
        escrow.getBounty(1);

        uint256 amount = 111 ether;
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 scopeHash = _scopeHash(amount, deadline, METADATA_HASH, bytes32(uint256(34)));
        bytes32 termsHash = _termsHash(scopeHash, PROPOSAL_HASH, provider);

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);

        BountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        assertEq(address(bounty.token), address(token));
        assertEq(bounty.scopeHash, scopeHash);
        assertEq(bounty.provider, provider);
        assertEq(bounty.proposalHash, PROPOSAL_HASH);
        assertEq(bounty.termsHash, termsHash);
    }

    function testCommitmentGoldenVectorsMatchFrontendCodec() public pure {
        assertEq(_goldenScopeHash(), 0x5cf9dda808e7029f9e3aa128aa4cb67f7ebc901508430dc080c22ca4a2c04c52);
        assertEq(_goldenTermsHash(), 0x6a82046797b3492677497b424bdc5a8ac16f3d5c8459adca6643e88f3c4da328);
        assertEq(_goldenEvidenceHash(), 0xd8f34218a457e5f938abcc957d873a84aeff2201213dab94612a8e48e9f2ef3f);
        assertEq(_goldenApprovalHash(), 0xf99877a3334f86ee1f72eeb6934cec009b12632dcfc5d9444fb9c5fca7a4e74d);
    }

    function _goldenScopeHash() internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("BOUNTY_SCOPE_V1"),
                uint256(84532),
                address(0x1111111111111111111111111111111111111111),
                address(0x2222222222222222222222222222222222222222),
                address(0x3333333333333333333333333333333333333333),
                uint256(2_500_000),
                uint64(1_786_465_600),
                bytes32(uint256(0x5555555555555555555555555555555555555555555555555555555555555555)),
                bytes32(uint256(0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa))
            )
        );
    }

    function _goldenTermsHash() internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("BOUNTY_TERMS_V1"),
                uint256(84532),
                address(0x1111111111111111111111111111111111111111),
                _goldenScopeHash(),
                bytes32(uint256(0x6666666666666666666666666666666666666666666666666666666666666666)),
                address(0x4444444444444444444444444444444444444444)
            )
        );
    }

    function _goldenEvidenceHash() internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("BOUNTY_EVIDENCE_V1"),
                uint256(84532),
                address(0x1111111111111111111111111111111111111111),
                uint256(7),
                _goldenScopeHash(),
                _goldenTermsHash(),
                address(0x4444444444444444444444444444444444444444),
                bytes32(uint256(0x7777777777777777777777777777777777777777777777777777777777777777)),
                bytes32(uint256(0x8888888888888888888888888888888888888888888888888888888888888888)),
                bytes32(uint256(0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa))
            )
        );
    }

    function _goldenApprovalHash() internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("BOUNTY_APPROVAL_V1"),
                uint256(84532),
                address(0x1111111111111111111111111111111111111111),
                uint256(7),
                _goldenEvidenceHash(),
                address(0x2222222222222222222222222222222222222222),
                bytes32(uint256(0x9999999999999999999999999999999999999999999999999999999999999999)),
                bytes32(uint256(0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa))
            )
        );
    }

    function AMOUNT() internal pure returns (uint256) {
        return 1 ether;
    }

    function _scopeHash(uint256 plannedAmount, uint64 deadline, bytes32 metadataHash, bytes32 salt)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                escrow.SCOPE_DOMAIN(),
                block.chainid,
                address(escrow),
                requester,
                address(token),
                plannedAmount,
                deadline,
                metadataHash,
                salt
            )
        );
    }

    function _termsHash(bytes32 scopeHash, bytes32 proposalHash, address selectedProvider)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(escrow.TERMS_DOMAIN(), block.chainid, address(escrow), scopeHash, proposalHash, selectedProvider)
        );
    }

    function _evidenceHash(
        uint256 bountyId,
        bytes32 scopeHash,
        bytes32 termsHash,
        address submittedBy,
        bytes32 contentHash,
        bytes32 uriHash,
        bytes32 salt
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                escrow.EVIDENCE_DOMAIN(),
                block.chainid,
                address(escrow),
                bountyId,
                scopeHash,
                termsHash,
                submittedBy,
                contentHash,
                uriHash,
                salt
            )
        );
    }

    function _approvalHash(uint256 bountyId, bytes32 evidenceHash, address buyer, bytes32 decisionHash, bytes32 salt)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                escrow.APPROVAL_DOMAIN(),
                block.chainid,
                address(escrow),
                bountyId,
                evidenceHash,
                buyer,
                decisionHash,
                salt
            )
        );
    }
}
