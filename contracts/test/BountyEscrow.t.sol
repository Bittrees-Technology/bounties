// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {BountyEscrow} from "../src/BountyEscrow.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {ReentrantERC20} from "./mocks/ReentrantERC20.sol";

contract BountyEscrowTest is Test {
    BountyEscrow internal escrow;
    MockERC20 internal token;

    address internal requester = makeAddr("requester");
    address internal provider = makeAddr("provider");
    address internal arbiter = makeAddr("arbiter");
    address internal guardian = makeAddr("guardian");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant AMOUNT = 1_000 ether;

    function setUp() public {
        escrow = new BountyEscrow(address(this), arbiter, guardian);
        token = new MockERC20();
        token.mint(requester, type(uint128).max);
        vm.prank(requester);
        token.approve(address(escrow), type(uint256).max);
    }

    function testHappyPath() public {
        uint256 bountyId = _createFunded(AMOUNT, 0);

        vm.prank(requester);
        escrow.assignBounty(bountyId, provider);
        vm.prank(provider);
        escrow.markDelivered(bountyId);
        vm.prank(requester);
        escrow.acceptDelivery(bountyId);

        vm.prank(stranger);
        escrow.release(bountyId);

        BountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        assertEq(uint256(bounty.state), uint256(BountyEscrow.State.Released));
        assertEq(bounty.amount, 0);
        assertEq(token.balanceOf(provider), AMOUNT);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testUnauthorizedCallersRevertAcrossGatedFunctions() public {
        vm.prank(requester);
        uint256 unfundedId = escrow.createBounty(address(token), 0, 0);

        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.UnauthorizedActor.selector, unfundedId, stranger));
        vm.prank(stranger);
        escrow.fundBounty(unfundedId, AMOUNT);

        uint256 fundedId = _createFunded(AMOUNT, uint64(block.timestamp + 1 days));

        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.UnauthorizedActor.selector, fundedId, stranger));
        vm.prank(stranger);
        escrow.assignBounty(fundedId, provider);

        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.UnauthorizedActor.selector, fundedId, stranger));
        vm.prank(stranger);
        escrow.cancelBounty(fundedId);

        vm.prank(requester);
        escrow.assignBounty(fundedId, provider);

        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.UnauthorizedActor.selector, fundedId, stranger));
        vm.prank(stranger);
        escrow.markDelivered(fundedId);

        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.UnauthorizedActor.selector, fundedId, stranger));
        vm.prank(stranger);
        escrow.claimTimeoutRefund(fundedId);

        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.UnauthorizedActor.selector, fundedId, stranger));
        vm.prank(stranger);
        escrow.raiseDispute(fundedId);

        vm.prank(provider);
        escrow.markDelivered(fundedId);

        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.UnauthorizedActor.selector, fundedId, provider));
        vm.prank(provider);
        escrow.acceptDelivery(fundedId);

        uint256 disputedId = _createAssigned(AMOUNT, 0);
        vm.prank(requester);
        escrow.raiseDispute(disputedId);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, escrow.ARBITER_ROLE()
            )
        );
        vm.prank(stranger);
        escrow.resolveDispute(disputedId, AMOUNT);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, escrow.GUARDIAN_ROLE()
            )
        );
        vm.prank(stranger);
        escrow.pause();

        vm.prank(guardian);
        escrow.pause();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, escrow.GUARDIAN_ROLE()
            )
        );
        vm.prank(stranger);
        escrow.unpause();
    }

    function testReentrantTokenCannotReenterCreate() public {
        ReentrantERC20 reentrantToken = new ReentrantERC20();
        reentrantToken.mint(requester, AMOUNT);

        vm.startPrank(requester);
        reentrantToken.approve(address(escrow), AMOUNT);
        reentrantToken.arm(escrow);
        vm.expectRevert(bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        escrow.createBounty(address(reentrantToken), AMOUNT, 0);
        vm.stopPrank();

        assertEq(escrow.nextBountyId(), 1);
        assertEq(reentrantToken.balanceOf(address(escrow)), 0);
    }

    function testDoubleAcceptAndDoubleReleaseRevert() public {
        uint256 bountyId = _createAssigned(AMOUNT, 0);
        vm.prank(provider);
        escrow.markDelivered(bountyId);
        vm.prank(requester);
        escrow.acceptDelivery(bountyId);

        vm.expectRevert(
            abi.encodeWithSelector(BountyEscrow.InvalidState.selector, bountyId, BountyEscrow.State.Accepted)
        );
        vm.prank(requester);
        escrow.acceptDelivery(bountyId);

        escrow.release(bountyId);
        vm.expectRevert(
            abi.encodeWithSelector(BountyEscrow.InvalidState.selector, bountyId, BountyEscrow.State.Released)
        );
        escrow.release(bountyId);
    }

    function testRequesterCanCancelBeforeAssignment() public {
        uint256 requesterBefore = token.balanceOf(requester);
        uint256 bountyId = _createFunded(AMOUNT, 0);

        vm.prank(requester);
        escrow.cancelBounty(bountyId);

        BountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        assertEq(uint256(bounty.state), uint256(BountyEscrow.State.Refunded));
        assertEq(token.balanceOf(requester), requesterBefore);
    }

    function testRequesterCanRefundAssignedBountyAfterTimeout() public {
        uint64 deadline = uint64(block.timestamp + 7 days);
        uint256 requesterBefore = token.balanceOf(requester);
        uint256 bountyId = _createAssigned(AMOUNT, deadline);

        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.RefundNotAvailable.selector, bountyId, deadline));
        vm.prank(requester);
        escrow.claimTimeoutRefund(bountyId);

        vm.warp(deadline);
        vm.prank(requester);
        escrow.claimTimeoutRefund(bountyId);

        BountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        assertEq(uint256(bounty.state), uint256(BountyEscrow.State.Refunded));
        assertEq(token.balanceOf(requester), requesterBefore);
    }

    function testDisputeResolutionCanReleaseAllToProvider() public {
        uint256 bountyId = _createAssigned(AMOUNT, 0);
        vm.prank(provider);
        escrow.raiseDispute(bountyId);

        vm.prank(arbiter);
        escrow.resolveDispute(bountyId, AMOUNT);

        BountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        assertEq(uint256(bounty.state), uint256(BountyEscrow.State.Resolved));
        assertEq(token.balanceOf(provider), AMOUNT);
    }

    function testDisputeResolutionCanRefundAllToRequester() public {
        uint256 requesterBefore = token.balanceOf(requester);
        uint256 bountyId = _createAssigned(AMOUNT, 0);
        vm.prank(requester);
        escrow.raiseDispute(bountyId);

        vm.prank(arbiter);
        escrow.resolveDispute(bountyId, 0);

        BountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        assertEq(uint256(bounty.state), uint256(BountyEscrow.State.Resolved));
        assertEq(token.balanceOf(requester), requesterBefore);
    }

    function testDisputeResolutionCanSplitEscrow() public {
        uint256 bountyId = _createAssigned(AMOUNT, 0);
        vm.prank(provider);
        escrow.markDelivered(bountyId);
        vm.prank(requester);
        escrow.raiseDispute(bountyId);

        vm.prank(arbiter);
        escrow.resolveDispute(bountyId, 400 ether);

        assertEq(token.balanceOf(provider), 400 ether);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testPauseBlocksCreationAndFunding() public {
        vm.prank(requester);
        uint256 unfundedId = escrow.createBounty(address(token), 0, 0);
        vm.prank(guardian);
        escrow.pause();

        vm.expectRevert(bytes4(keccak256("EnforcedPause()")));
        vm.prank(requester);
        escrow.createBounty(address(token), AMOUNT, 0);

        vm.expectRevert(bytes4(keccak256("EnforcedPause()")));
        vm.prank(requester);
        escrow.fundBounty(unfundedId, AMOUNT);
    }

    function testPauseDoesNotBlockReleaseRefundOrResolve() public {
        uint256 releaseId = _createAssigned(AMOUNT, 0);
        vm.prank(provider);
        escrow.markDelivered(releaseId);
        vm.prank(requester);
        escrow.acceptDelivery(releaseId);

        uint256 refundId = _createFunded(AMOUNT, 0);

        uint256 resolveId = _createAssigned(AMOUNT, 0);
        vm.prank(provider);
        escrow.raiseDispute(resolveId);

        vm.prank(guardian);
        escrow.pause();

        escrow.release(releaseId);
        vm.prank(requester);
        escrow.cancelBounty(refundId);
        vm.prank(arbiter);
        escrow.resolveDispute(resolveId, AMOUNT);

        assertEq(uint256(escrow.getBounty(releaseId).state), uint256(BountyEscrow.State.Released));
        assertEq(uint256(escrow.getBounty(refundId).state), uint256(BountyEscrow.State.Refunded));
        assertEq(uint256(escrow.getBounty(resolveId).state), uint256(BountyEscrow.State.Resolved));
    }

    function _createFunded(uint256 amount, uint64 deadline) internal returns (uint256 bountyId) {
        vm.prank(requester);
        bountyId = escrow.createBounty(address(token), amount, deadline);
    }

    function _createAssigned(uint256 amount, uint64 deadline) internal returns (uint256 bountyId) {
        bountyId = _createFunded(amount, deadline);
        vm.prank(requester);
        escrow.assignBounty(bountyId, provider);
    }
}
