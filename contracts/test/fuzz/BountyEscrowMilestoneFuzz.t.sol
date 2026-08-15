// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {BountyEscrow} from "../../src/BountyEscrow.sol";
import {IBountyEscrow} from "../../src/IBountyEscrow.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract BountyEscrowMilestoneFuzzTest is Test {
    address internal requester = makeAddr("milestone-fuzz-requester");
    address internal provider = makeAddr("milestone-fuzz-provider");

    function testFuzzMilestoneAllocationsConserveFundedPrincipal(
        uint96 rawFirst,
        uint96 rawSecond,
        uint96 rawThird,
        bool releaseByReview
    ) public {
        uint256 first = bound(uint256(rawFirst), 1, type(uint88).max);
        uint256 second = bound(uint256(rawSecond), 1, type(uint88).max);
        uint256 third = bound(uint256(rawThird), 1, type(uint88).max);
        uint256 total = first + second + third;

        BountyEscrow escrow = new BountyEscrow();
        MockERC20 token = new MockERC20();
        token.mint(requester, total);
        vm.prank(requester);
        token.approve(address(escrow), total);

        uint256[] memory amounts = new uint256[](3);
        amounts[0] = first;
        amounts[1] = second;
        amounts[2] = third;
        uint64[] memory deadlines = new uint64[](3);
        deadlines[0] = uint64(block.timestamp + 8 days);
        deadlines[1] = uint64(block.timestamp + 30 days);
        deadlines[2] = uint64(block.timestamp + 52 days);

        vm.prank(requester);
        uint256 bountyId = escrow.createMilestoneBounty(
            address(token), total, amounts, deadlines, keccak256("scope"), provider, keccak256("proposal")
        );
        bytes32 termsHash = escrow.getBounty(bountyId).termsHash;
        vm.prank(provider);
        escrow.acceptBounty(bountyId, termsHash);

        for (uint256 i; i < amounts.length; ++i) {
            vm.prank(provider);
            escrow.submitDelivery(bountyId, keccak256(abi.encode("evidence", i)));
            if (releaseByReview) {
                vm.warp(escrow.getBounty(bountyId).reviewDeadline);
            } else {
                vm.prank(requester);
                escrow.approveDelivery(bountyId, keccak256(abi.encode("approval", i)));
            }
            vm.prank(makeAddr("release-caller"));
            escrow.release(bountyId);

            IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
            uint256 released = i == 0 ? first : (i == 1 ? first + second : total);
            assertEq(bounty.releasedAmount, released);
            assertEq(bounty.amount + bounty.releasedAmount, total);
            assertEq(escrow.totalLiability(address(token)), total - released);
        }

        assertEq(token.balanceOf(provider), total);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(uint256(escrow.getBounty(bountyId).state), uint256(IBountyEscrow.State.Released));
    }

    function testFuzzPartialReleaseThenSettlementConservesAllValue(
        uint96 rawFirst,
        uint96 rawRemaining,
        uint96 rawSettlementPayout
    ) public {
        uint256 first = bound(uint256(rawFirst), 1, type(uint88).max);
        uint256 remaining = bound(uint256(rawRemaining), 1, type(uint88).max);
        uint256 settlementPayout = bound(uint256(rawSettlementPayout), 0, remaining);
        uint256 total = first + remaining;

        BountyEscrow escrow = new BountyEscrow();
        MockERC20 token = new MockERC20();
        token.mint(requester, total);
        vm.prank(requester);
        token.approve(address(escrow), total);

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = first;
        amounts[1] = remaining;
        uint64[] memory deadlines = new uint64[](2);
        deadlines[0] = uint64(block.timestamp + 2 days);
        deadlines[1] = uint64(block.timestamp + 24 days);
        vm.prank(requester);
        uint256 bountyId = escrow.createMilestoneBounty(
            address(token), total, amounts, deadlines, keccak256("scope"), provider, keccak256("proposal")
        );
        bytes32 termsHash = escrow.getBounty(bountyId).termsHash;
        vm.prank(provider);
        escrow.acceptBounty(bountyId, termsHash);
        vm.prank(provider);
        escrow.submitDelivery(bountyId, keccak256("first evidence"));
        vm.prank(requester);
        escrow.approveDelivery(bountyId, keccak256("first approval"));
        escrow.release(bountyId);

        vm.prank(requester);
        escrow.proposeSettlement(bountyId, settlementPayout);
        vm.prank(provider);
        escrow.acceptSettlement(bountyId, settlementPayout);

        assertEq(token.balanceOf(provider), first + settlementPayout);
        assertEq(token.balanceOf(requester), remaining - settlementPayout);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalLiability(address(token)), 0);
    }

    function testFuzzOneRevisionPreservesPrincipalAndCreatesFixedDeadline(uint96 rawAmount, bytes32 reason) public {
        uint256 amount = bound(uint256(rawAmount), 1, type(uint88).max);
        if (reason == bytes32(0)) reason = bytes32(uint256(1));
        BountyEscrow escrow = new BountyEscrow();
        MockERC20 token = new MockERC20();
        token.mint(requester, amount);
        vm.prank(requester);
        token.approve(address(escrow), amount);
        uint64 deadline = uint64(block.timestamp + 2 days);

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(
            address(token), amount, deadline, keccak256("revision scope"), provider, keccak256("revision proposal")
        );
        bytes32 termsHash = escrow.getBounty(bountyId).termsHash;
        vm.prank(provider);
        escrow.acceptBounty(bountyId, termsHash);
        vm.prank(provider);
        escrow.submitDelivery(bountyId, keccak256("first submission"));
        uint64 expectedRevisionDeadline = uint64(block.timestamp) + 7 days;
        vm.prank(requester);
        escrow.requestRevision(bountyId, reason);

        IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        IBountyEscrow.Milestone memory milestone = escrow.getMilestone(bountyId, 0);
        assertEq(bounty.amount, amount);
        assertEq(escrow.totalLiability(address(token)), amount);
        assertEq(token.balanceOf(address(escrow)), amount);
        assertEq(bounty.deliveryDeadline, expectedRevisionDeadline);
        assertEq(milestone.revisionDeadline, expectedRevisionDeadline);
        assertEq(milestone.revisionReasonHash, reason);
        assertTrue(milestone.revisionRequested);
    }
}

contract MilestoneInvariantHandler is Test {
    BountyEscrow public immutable escrow;
    uint256 public immutable bountyId;
    address public immutable requester;
    address public immutable provider;

    constructor(BountyEscrow escrow_, uint256 bountyId_, address requester_, address provider_) {
        escrow = escrow_;
        bountyId = bountyId_;
        requester = requester_;
        provider = provider_;
    }

    function deliver(bytes32 evidence) external {
        IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        if (bounty.state != IBountyEscrow.State.ProviderAccepted) return;
        if (bounty.deliveryDeadline != 0 && block.timestamp >= bounty.deliveryDeadline) return;
        if (evidence == bytes32(0)) evidence = bytes32(uint256(1));
        IBountyEscrow.Milestone memory milestone = escrow.getMilestone(bountyId, bounty.currentMilestone);
        if (milestone.revisionRequested && evidence == milestone.previousEvidenceHash) {
            evidence = keccak256(abi.encode(evidence, "revision"));
        }
        vm.prank(provider);
        escrow.submitDelivery(bountyId, evidence);
    }

    function approve(bytes32 approval) external {
        IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        if (bounty.state != IBountyEscrow.State.Delivered) return;
        if (approval == bytes32(0)) approval = bytes32(uint256(1));
        vm.prank(requester);
        escrow.approveDelivery(bountyId, approval);
    }

    function requestRevision(bytes32 reason) external {
        IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        if (bounty.state != IBountyEscrow.State.Delivered || block.timestamp >= bounty.reviewDeadline) return;
        IBountyEscrow.Milestone memory milestone = escrow.getMilestone(bountyId, bounty.currentMilestone);
        if (milestone.revisionRequested) return;
        if (reason == bytes32(0)) reason = bytes32(uint256(1));
        vm.prank(requester);
        escrow.requestRevision(bountyId, reason);
    }

    function release() external {
        IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        bool available = bounty.state == IBountyEscrow.State.BuyerApproved
            || (bounty.state == IBountyEscrow.State.Delivered && block.timestamp >= bounty.reviewDeadline);
        if (!available) return;
        escrow.release(bountyId);
    }

    function proposeSettlement(uint96 rawPayout, bool providerProposes) external {
        IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        if (!_settlementState(bounty.state)) return;
        if (
            ((bounty.state == IBountyEscrow.State.Funded || bounty.state == IBountyEscrow.State.ProviderAccepted)
                    && block.timestamp >= bounty.deliveryDeadline)
                || (bounty.state == IBountyEscrow.State.Delivered && block.timestamp >= bounty.reviewDeadline)
        ) return;
        uint256 payout = bound(uint256(rawPayout), 0, bounty.amount);
        vm.prank(providerProposes ? provider : requester);
        escrow.proposeSettlement(bountyId, payout);
    }

    function acceptSettlement() external {
        IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        if (!_settlementState(bounty.state) || bounty.settlementProposer == address(0)) return;
        if (block.timestamp >= bounty.settlementProposalExpiry) return;
        vm.prank(bounty.settlementProposer == requester ? provider : requester);
        escrow.acceptSettlement(bountyId, bounty.proposedProviderPayout);
    }

    function cancelSettlementProposal() external {
        IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        if (bounty.settlementProposer == address(0)) return;
        vm.prank(bounty.settlementProposer);
        escrow.cancelSettlementProposal(bountyId);
    }

    function refund() external {
        IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        if (
            (bounty.state != IBountyEscrow.State.Funded && bounty.state != IBountyEscrow.State.ProviderAccepted)
                || bounty.deliveryDeadline == 0 || block.timestamp < bounty.deliveryDeadline
        ) return;
        vm.prank(address(0xCA11));
        escrow.refundBounty(bountyId);
    }

    function advanceTime(uint32 rawSeconds) external {
        vm.warp(block.timestamp + bound(uint256(rawSeconds), 1, 10 days));
    }

    function _settlementState(IBountyEscrow.State state) private pure returns (bool) {
        return state == IBountyEscrow.State.Funded || state == IBountyEscrow.State.ProviderAccepted
            || state == IBountyEscrow.State.Delivered || state == IBountyEscrow.State.BuyerApproved;
    }
}

contract BountyEscrowMilestoneInvariantTest is StdInvariant, Test {
    BountyEscrow internal escrow;
    MockERC20 internal token;
    MilestoneInvariantHandler internal handler;
    uint256 internal bountyId;

    address internal requester = makeAddr("milestone-invariant-requester");
    address internal provider = makeAddr("milestone-invariant-provider");
    uint256 internal constant TOTAL = 1_000 ether;

    function setUp() public {
        escrow = new BountyEscrow();
        token = new MockERC20();
        token.mint(requester, TOTAL);
        vm.prank(requester);
        token.approve(address(escrow), TOTAL);

        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 200 ether;
        amounts[1] = 300 ether;
        amounts[2] = 500 ether;
        uint64[] memory deadlines = new uint64[](3);
        deadlines[0] = uint64(block.timestamp + 10 days);
        deadlines[1] = uint64(block.timestamp + 32 days);
        deadlines[2] = uint64(block.timestamp + 54 days);
        vm.prank(requester);
        bountyId = escrow.createMilestoneBounty(
            address(token), TOTAL, amounts, deadlines, keccak256("scope"), provider, keccak256("proposal")
        );
        bytes32 termsHash = escrow.getBounty(bountyId).termsHash;
        vm.prank(provider);
        escrow.acceptBounty(bountyId, termsHash);

        handler = new MilestoneInvariantHandler(escrow, bountyId, requester, provider);
        targetContract(address(handler));
    }

    function invariantAllocationConservation() public view {
        IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        assertEq(bounty.allocatedAmount, TOTAL);
        assertLe(bounty.releasedAmount + bounty.amount, TOTAL);
        if (
            bounty.state != IBountyEscrow.State.Settled && bounty.state != IBountyEscrow.State.Refunded
                && bounty.state != IBountyEscrow.State.Cancelled
        ) {
            assertEq(bounty.releasedAmount + bounty.amount, TOTAL);
        }
        assertEq(escrow.totalLiability(address(token)), bounty.amount);
        assertGe(token.balanceOf(address(escrow)), bounty.amount);
    }

    function invariantMilestonesRemainSequential() public view {
        IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        for (uint256 i; i < bounty.milestoneCount; ++i) {
            IBountyEscrow.Milestone memory milestone = escrow.getMilestone(bountyId, i);
            if (i < bounty.currentMilestone) {
                assertEq(uint256(milestone.state), uint256(IBountyEscrow.MilestoneState.Released));
            } else if (i > bounty.currentMilestone) {
                assertEq(uint256(milestone.state), uint256(IBountyEscrow.MilestoneState.Pending));
            }
        }
    }

    function invariantStandardTokenValueIsConserved() public view {
        assertEq(token.balanceOf(requester) + token.balanceOf(provider) + token.balanceOf(address(escrow)), TOTAL);
    }
}
