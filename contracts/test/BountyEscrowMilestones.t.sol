// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {BountyEscrow} from "../src/BountyEscrow.sol";
import {IBountyEscrow} from "../src/IBountyEscrow.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract BountyEscrowMilestonesTest is Test {
    BountyEscrow internal escrow;
    MockERC20 internal token;

    address internal requester = makeAddr("milestone-requester");
    address internal provider = makeAddr("milestone-provider");
    address internal caller = makeAddr("permissionless-caller");

    bytes32 internal constant SCOPE_HASH = keccak256("milestone-scope");
    bytes32 internal constant PROPOSAL_HASH = keccak256("milestone-proposal");
    uint256 internal constant TOTAL = 1_000 ether;

    function setUp() public {
        escrow = new BountyEscrow();
        token = new MockERC20();
        token.mint(requester, 10_000 ether);
        vm.prank(requester);
        token.approve(address(escrow), type(uint256).max);
    }

    function testMilestoneScheduleMustBePositiveBoundedOrderedAndExactlyFunded() public {
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 400 ether;
        amounts[1] = 600 ether;
        uint64[] memory deadlines = new uint64[](2);
        deadlines[0] = uint64(block.timestamp + 2 days);
        deadlines[1] = uint64(block.timestamp + 24 days);

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.MilestoneFundingMismatch.selector, TOTAL, TOTAL - 1));
        vm.prank(requester);
        escrow.createMilestoneBounty(address(token), TOTAL - 1, amounts, deadlines, SCOPE_HASH, provider, PROPOSAL_HASH);

        amounts[1] = 0;
        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.InvalidMilestoneAmount.selector, 1, 0));
        vm.prank(requester);
        escrow.createMilestoneBounty(address(token), 0, amounts, deadlines, SCOPE_HASH, provider, PROPOSAL_HASH);

        amounts[1] = 600 ether;
        deadlines[1] = deadlines[0] + escrow.MIN_MILESTONE_SPACING();
        vm.expectRevert(
            abi.encodeWithSelector(IBountyEscrow.InvalidMilestoneDeadline.selector, 1, deadlines[0], deadlines[1])
        );
        vm.prank(requester);
        escrow.createMilestoneBounty(address(token), 0, amounts, deadlines, SCOPE_HASH, provider, PROPOSAL_HASH);
        deadlines[1] = deadlines[0];
        vm.expectRevert(
            abi.encodeWithSelector(IBountyEscrow.InvalidMilestoneDeadline.selector, 1, deadlines[0], deadlines[1])
        );
        vm.prank(requester);
        escrow.createMilestoneBounty(address(token), 0, amounts, deadlines, SCOPE_HASH, provider, PROPOSAL_HASH);

        uint64[] memory shortDeadlines = new uint64[](1);
        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.MilestoneArrayLengthMismatch.selector, 2, 1));
        vm.prank(requester);
        escrow.createMilestoneBounty(address(token), 0, amounts, shortDeadlines, SCOPE_HASH, provider, PROPOSAL_HASH);

        uint256[] memory none = new uint256[](0);
        uint64[] memory noDeadlines = new uint64[](0);
        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.InvalidMilestoneCount.selector, 0));
        vm.prank(requester);
        escrow.createMilestoneBounty(address(token), 0, none, noDeadlines, SCOPE_HASH, provider, PROPOSAL_HASH);
    }

    function testUnfundedScheduleCanOnlyBeFundedWithExactAllocationSum() public {
        (uint256[] memory amounts, uint64[] memory deadlines) = _schedule();

        vm.prank(requester);
        uint256 bountyId =
            escrow.createMilestoneBounty(address(token), 0, amounts, deadlines, SCOPE_HASH, provider, PROPOSAL_HASH);

        IBountyEscrow.Bounty memory created = escrow.getBounty(bountyId);
        assertEq(created.amount, 0);
        assertEq(created.allocatedAmount, TOTAL);
        assertEq(created.milestoneCount, 3);
        assertEq(uint256(created.state), uint256(IBountyEscrow.State.Created));

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.MilestoneFundingMismatch.selector, TOTAL, TOTAL - 1));
        vm.prank(requester);
        escrow.fundBounty(bountyId, TOTAL - 1);

        vm.prank(requester);
        escrow.fundBounty(bountyId, TOTAL);
        assertEq(escrow.totalLiability(address(token)), TOTAL);
        assertEq(escrow.getBounty(bountyId).amount, TOTAL);
    }

    function testCommittedMilestoneScheduleCanOnlyBeCreatedOncePerRequester() public {
        (uint256[] memory amounts, uint64[] memory deadlines) = _schedule();

        vm.prank(requester);
        uint256 bountyId = escrow.createMilestoneBounty(
            address(token), TOTAL, amounts, deadlines, SCOPE_HASH, provider, PROPOSAL_HASH
        );
        IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);

        assertEq(escrow.bountyIdByRequesterAndTermsHash(requester, bounty.termsHash), bountyId);
        vm.expectRevert(
            abi.encodeWithSelector(IBountyEscrow.DuplicateBounty.selector, requester, bounty.termsHash, bountyId)
        );
        vm.prank(requester);
        escrow.createMilestoneBounty(address(token), TOTAL, amounts, deadlines, SCOPE_HASH, provider, PROPOSAL_HASH);
        assertEq(escrow.nextBountyId(), bountyId + 1);
        assertEq(escrow.totalLiability(address(token)), TOTAL);
        assertEq(token.balanceOf(address(escrow)), TOTAL);
    }

    function testThreeMilestonesReleaseSequentiallyByApprovalAndReviewExpiry() public {
        (uint256 bountyId, uint256[] memory amounts, uint64[] memory deadlines) = _createFundedAndAccept();

        _deliver(bountyId, bytes32(uint256(1)));
        vm.prank(requester);
        escrow.approveDelivery(bountyId, bytes32(uint256(101)));
        vm.prank(caller);
        escrow.release(bountyId);

        _assertReleasedMilestone(bountyId, 0, amounts[0]);
        IBountyEscrow.Bounty memory afterFirst = escrow.getBounty(bountyId);
        assertEq(afterFirst.currentMilestone, 1);
        assertEq(afterFirst.amount, amounts[1] + amounts[2]);
        assertEq(afterFirst.releasedAmount, amounts[0]);
        assertEq(afterFirst.deliveryDeadline, deadlines[1]);
        assertEq(uint256(afterFirst.state), uint256(IBountyEscrow.State.ProviderAccepted));

        _deliver(bountyId, bytes32(uint256(2)));
        uint64 secondReviewDeadline = escrow.getBounty(bountyId).reviewDeadline;
        vm.warp(secondReviewDeadline - 1);
        vm.expectRevert(
            abi.encodeWithSelector(IBountyEscrow.ReviewPeriodActive.selector, bountyId, secondReviewDeadline)
        );
        vm.prank(caller);
        escrow.release(bountyId);
        vm.warp(secondReviewDeadline);
        vm.prank(caller);
        escrow.release(bountyId);

        _assertReleasedMilestone(bountyId, 1, amounts[1]);
        assertEq(escrow.getBounty(bountyId).currentMilestone, 2);

        _deliver(bountyId, bytes32(uint256(3)));
        vm.prank(requester);
        escrow.approveDelivery(bountyId, bytes32(uint256(103)));
        vm.prank(caller);
        escrow.release(bountyId);

        IBountyEscrow.Bounty memory completed = escrow.getBounty(bountyId);
        _assertReleasedMilestone(bountyId, 2, amounts[2]);
        assertEq(uint256(completed.state), uint256(IBountyEscrow.State.Released));
        assertEq(completed.amount, 0);
        assertEq(completed.releasedAmount, TOTAL);
        assertEq(token.balanceOf(provider), TOTAL);
        assertEq(escrow.totalLiability(address(token)), 0);
    }

    function testCannotSubmitLaterMilestoneBeforeCurrentRelease() public {
        (uint256 bountyId,,) = _createFundedAndAccept();
        _deliver(bountyId, bytes32(uint256(1)));

        vm.expectRevert(
            abi.encodeWithSelector(
                IBountyEscrow.InvalidState.selector,
                bountyId,
                IBountyEscrow.State.Delivered,
                IBountyEscrow.State.ProviderAccepted
            )
        );
        vm.prank(provider);
        escrow.submitDelivery(bountyId, bytes32(uint256(2)));

        IBountyEscrow.Milestone memory second = escrow.getMilestone(bountyId, 1);
        assertEq(uint256(second.state), uint256(IBountyEscrow.MilestoneState.Pending));
        assertEq(second.evidenceHash, bytes32(0));
    }

    function testMissedCurrentMilestoneDeadlineRefundsOnlyUnreleasedPrincipal() public {
        (uint256 bountyId, uint256[] memory amounts, uint64[] memory deadlines) = _createFundedAndAccept();
        _deliver(bountyId, bytes32(uint256(1)));
        vm.prank(requester);
        escrow.approveDelivery(bountyId, bytes32(uint256(11)));
        escrow.release(bountyId);

        uint256 requesterBefore = token.balanceOf(requester);
        vm.warp(deadlines[1]);
        vm.prank(requester);
        escrow.refundBounty(bountyId);

        IBountyEscrow.Bounty memory refunded = escrow.getBounty(bountyId);
        assertEq(uint256(refunded.state), uint256(IBountyEscrow.State.Refunded));
        assertEq(refunded.amount, 0);
        assertEq(refunded.releasedAmount, amounts[0]);
        assertEq(token.balanceOf(provider), amounts[0]);
        assertEq(token.balanceOf(requester), requesterBefore + amounts[1] + amounts[2]);
        assertEq(escrow.totalLiability(address(token)), 0);
    }

    function testBilateralSettlementAfterPartialReleaseOnlySplitsRemainingPrincipal() public {
        (uint256 bountyId, uint256[] memory amounts,) = _createFundedAndAccept();
        _deliver(bountyId, bytes32(uint256(1)));
        vm.prank(requester);
        escrow.approveDelivery(bountyId, bytes32(uint256(21)));
        escrow.release(bountyId);

        uint256 remaining = amounts[1] + amounts[2];
        uint256 providerPayout = 250 ether;
        vm.prank(provider);
        escrow.proposeSettlement(bountyId, providerPayout);
        vm.prank(requester);
        escrow.acceptSettlement(bountyId, providerPayout);

        IBountyEscrow.Bounty memory settled = escrow.getBounty(bountyId);
        assertEq(uint256(settled.state), uint256(IBountyEscrow.State.Settled));
        assertEq(settled.amount, 0);
        assertEq(settled.releasedAmount, amounts[0]);
        assertEq(token.balanceOf(provider), amounts[0] + providerPayout);
        assertEq(token.balanceOf(requester), 10_000 ether - amounts[0] - providerPayout);
        assertEq(remaining - providerPayout, 450 ether);
        assertEq(escrow.totalLiability(address(token)), 0);
    }

    function testSettlementOfferIsInvalidatedByMilestoneLifecycleTransitions() public {
        (uint256 bountyId,,) = _createFunded();

        vm.prank(requester);
        escrow.proposeSettlement(bountyId, 1 ether);
        bytes32 termsHash = escrow.getBounty(bountyId).termsHash;
        vm.prank(provider);
        escrow.acceptBounty(bountyId, termsHash);
        _expectNoCurrentSettlement(bountyId, requester);

        vm.prank(provider);
        escrow.proposeSettlement(bountyId, 2 ether);
        _deliver(bountyId, bytes32(uint256(31)));
        _expectNoCurrentSettlement(bountyId, requester);

        vm.prank(provider);
        escrow.proposeSettlement(bountyId, 3 ether);
        vm.prank(requester);
        escrow.approveDelivery(bountyId, bytes32(uint256(32)));
        vm.prank(provider);
        escrow.proposeSettlement(bountyId, 3 ether);
        vm.prank(requester);
        escrow.acceptSettlement(bountyId, 3 ether);
        assertEq(uint256(escrow.getBounty(bountyId).state), uint256(IBountyEscrow.State.Settled));
    }

    function testScheduleHashAndTermsHashBindExactMilestonePlan() public {
        (uint256[] memory amounts, uint64[] memory deadlines) = _schedule();
        vm.prank(requester);
        uint256 bountyId = escrow.createMilestoneBounty(
            address(token), TOTAL, amounts, deadlines, SCOPE_HASH, provider, PROPOSAL_HASH
        );

        bytes32 expectedSchedule = keccak256(
            abi.encode(
                escrow.MILESTONE_SCHEDULE_DOMAIN(), block.chainid, address(escrow), SCOPE_HASH, amounts, deadlines
            )
        );
        bytes32 expectedTerms = keccak256(
            abi.encode(
                escrow.MILESTONE_TERMS_DOMAIN(),
                block.chainid,
                address(escrow),
                SCOPE_HASH,
                PROPOSAL_HASH,
                provider,
                expectedSchedule
            )
        );
        IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        assertEq(bounty.scheduleHash, expectedSchedule);
        assertEq(bounty.termsHash, expectedTerms);
    }

    function _schedule() internal view returns (uint256[] memory amounts, uint64[] memory deadlines) {
        amounts = new uint256[](3);
        amounts[0] = 300 ether;
        amounts[1] = 400 ether;
        amounts[2] = 300 ether;
        deadlines = new uint64[](3);
        deadlines[0] = uint64(block.timestamp + 3 days);
        deadlines[1] = uint64(block.timestamp + 25 days);
        deadlines[2] = uint64(block.timestamp + 47 days);
    }

    function _createFunded() internal returns (uint256 bountyId, uint256[] memory amounts, uint64[] memory deadlines) {
        (amounts, deadlines) = _schedule();
        vm.prank(requester);
        bountyId = escrow.createMilestoneBounty(
            address(token), TOTAL, amounts, deadlines, SCOPE_HASH, provider, PROPOSAL_HASH
        );
    }

    function _createFundedAndAccept()
        internal
        returns (uint256 bountyId, uint256[] memory amounts, uint64[] memory deadlines)
    {
        (bountyId, amounts, deadlines) = _createFunded();
        bytes32 termsHash = escrow.getBounty(bountyId).termsHash;
        vm.prank(provider);
        escrow.acceptBounty(bountyId, termsHash);
    }

    function _deliver(uint256 bountyId, bytes32 evidenceHash) internal {
        vm.prank(provider);
        escrow.submitDelivery(bountyId, evidenceHash);
    }

    function _assertReleasedMilestone(uint256 bountyId, uint256 index, uint256 amount) internal view {
        IBountyEscrow.Milestone memory milestone = escrow.getMilestone(bountyId, index);
        assertEq(milestone.amount, amount);
        assertEq(uint256(milestone.state), uint256(IBountyEscrow.MilestoneState.Released));
        assertTrue(milestone.evidenceHash != bytes32(0));
    }

    function _expectNoCurrentSettlement(uint256 bountyId, address actor) internal {
        vm.expectRevert(
            abi.encodeWithSelector(IBountyEscrow.SettlementAcceptanceUnavailable.selector, bountyId, actor, address(0))
        );
        vm.prank(actor);
        escrow.acceptSettlement(bountyId, 0);
    }
}
