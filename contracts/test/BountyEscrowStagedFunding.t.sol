// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {BountyEscrow} from "../src/BountyEscrow.sol";
import {IBountyEscrow} from "../src/IBountyEscrow.sol";
import {FeeOnTransferERC20} from "./mocks/FeeOnTransferERC20.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {SenderTaxERC20} from "./mocks/SenderTaxERC20.sol";

contract BountyEscrowStagedFundingTest is Test {
    BountyEscrow internal escrow;
    MockERC20 internal token;

    address internal requester = makeAddr("staged-requester");
    address internal provider = makeAddr("staged-provider");
    address internal caller = makeAddr("staged-caller");

    bytes32 internal constant SCOPE_HASH = keccak256("staged-scope");
    bytes32 internal constant PROPOSAL_HASH = keccak256("staged-proposal");
    uint256 internal constant FIRST = 200 ether;
    uint256 internal constant SECOND = 300 ether;
    uint256 internal constant THIRD = 500 ether;
    uint256 internal constant TOTAL = FIRST + SECOND + THIRD;

    function setUp() public {
        escrow = new BountyEscrow();
        token = new MockERC20();
        token.mint(requester, 10_000 ether);
        vm.prank(requester);
        token.approve(address(escrow), type(uint256).max);
    }

    function testSequentialFundingPausesAndResumesBetweenReleasedMilestones() public {
        (uint256[] memory amounts, uint64[] memory deadlines) = _schedule();
        vm.prank(requester);
        uint256 bountyId = escrow.createMilestoneBounty(
            address(token), FIRST, amounts, deadlines, SCOPE_HASH, provider, PROPOSAL_HASH
        );

        assertEq(escrow.fundedMilestoneCount(bountyId), 1);
        assertEq(escrow.getBounty(bountyId).amount, FIRST);
        assertEq(escrow.totalLiability(address(token)), FIRST);

        _accept(bountyId);
        _deliverApproveRelease(bountyId, 1);

        IBountyEscrow.Bounty memory awaiting = escrow.getBounty(bountyId);
        assertEq(uint256(awaiting.state), uint256(IBountyEscrow.State.AwaitingFunding));
        assertEq(awaiting.amount, 0);
        assertEq(awaiting.releasedAmount, FIRST);
        assertEq(awaiting.currentMilestone, 1);
        assertEq(awaiting.deliveryDeadline, deadlines[1]);
        assertEq(token.balanceOf(provider), FIRST);

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.UnfundedMilestoneActive.selector, bountyId, 1));
        vm.prank(provider);
        escrow.submitDelivery(bountyId, keccak256("unfunded evidence"));

        vm.prank(requester);
        escrow.fundMilestones(bountyId, 1);
        IBountyEscrow.Bounty memory resumed = escrow.getBounty(bountyId);
        assertEq(uint256(resumed.state), uint256(IBountyEscrow.State.ProviderAccepted));
        assertEq(resumed.amount, SECOND);
        assertEq(escrow.fundedMilestoneCount(bountyId), 2);

        _deliverApproveRelease(bountyId, 2);
        assertEq(uint256(escrow.getBounty(bountyId).state), uint256(IBountyEscrow.State.AwaitingFunding));

        vm.prank(requester);
        escrow.fundMilestones(bountyId, 2);
        _deliverApproveRelease(bountyId, 3);

        IBountyEscrow.Bounty memory completed = escrow.getBounty(bountyId);
        assertEq(uint256(completed.state), uint256(IBountyEscrow.State.Released));
        assertEq(completed.amount, 0);
        assertEq(completed.releasedAmount, TOTAL);
        assertEq(escrow.totalLiability(address(token)), 0);
        assertEq(token.balanceOf(provider), TOTAL);
    }

    function testRequesterCanFundMultipleRemainingMilestonesWithoutDuplicateCharges() public {
        (uint256 bountyId,,) = _createFirstMilestoneFunded();
        uint256 requesterBefore = token.balanceOf(requester);

        vm.prank(requester);
        escrow.fundMilestones(bountyId, 2);

        assertEq(escrow.fundedMilestoneCount(bountyId), 3);
        assertEq(escrow.getBounty(bountyId).amount, TOTAL);
        assertEq(requesterBefore - token.balanceOf(requester), SECOND + THIRD);
        assertEq(escrow.totalLiability(address(token)), TOTAL);

        uint256 escrowBefore = token.balanceOf(address(escrow));
        uint256 requesterAfter = token.balanceOf(requester);
        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.InvalidMilestoneFundingTarget.selector, bountyId, 3, 2));
        vm.prank(requester);
        escrow.fundMilestones(bountyId, 2);
        assertEq(token.balanceOf(address(escrow)), escrowBefore);
        assertEq(token.balanceOf(requester), requesterAfter);
    }

    function testPartiallyFundedBountyCanCancelBeforeAcceptanceAndRefundExactly() public {
        (uint256 bountyId,,) = _createFirstMilestoneFunded();
        uint256 requesterBefore = token.balanceOf(requester);

        vm.prank(requester);
        escrow.cancelBounty(bountyId);

        IBountyEscrow.Bounty memory cancelled = escrow.getBounty(bountyId);
        assertEq(uint256(cancelled.state), uint256(IBountyEscrow.State.Cancelled));
        assertEq(cancelled.amount, 0);
        assertEq(token.balanceOf(requester), requesterBefore + FIRST);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalLiability(address(token)), 0);
    }

    function testUnfundedNextMilestoneCanCloseAfterDeadlineWithReleasedHistoryPreserved() public {
        (uint256 bountyId,, uint64[] memory deadlines) = _createFirstMilestoneFunded();
        _accept(bountyId);
        _deliverApproveRelease(bountyId, 1);

        vm.expectRevert(
            abi.encodeWithSelector(IBountyEscrow.UnfundedMilestonePeriodActive.selector, bountyId, deadlines[1])
        );
        vm.prank(caller);
        escrow.closeUnfundedBounty(bountyId);

        vm.warp(deadlines[1]);
        vm.prank(caller);
        escrow.closeUnfundedBounty(bountyId);

        IBountyEscrow.Bounty memory closed = escrow.getBounty(bountyId);
        assertEq(uint256(closed.state), uint256(IBountyEscrow.State.PartiallyCompleted));
        assertEq(closed.amount, 0);
        assertEq(closed.releasedAmount, FIRST);
        assertEq(token.balanceOf(provider), FIRST);
        assertEq(escrow.totalLiability(address(token)), 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                IBountyEscrow.MilestoneFundingUnavailable.selector, bountyId, IBountyEscrow.State.PartiallyCompleted
            )
        );
        vm.prank(requester);
        escrow.fundMilestones(bountyId, 1);
    }

    function testOriginalFullUpfrontFundingPathRemainsAvailable() public {
        (uint256[] memory amounts,) = _schedule();
        (uint256 bountyId,,) = _createWithFunding(TOTAL);
        assertEq(escrow.fundedMilestoneCount(bountyId), amounts.length);
        assertEq(escrow.getBounty(bountyId).amount, TOTAL);
        _accept(bountyId);

        for (uint256 i; i < amounts.length; ++i) {
            _deliverApproveRelease(bountyId, i + 11);
            if (i + 1 < amounts.length) {
                assertEq(uint256(escrow.getBounty(bountyId).state), uint256(IBountyEscrow.State.ProviderAccepted));
            }
        }
        assertEq(uint256(escrow.getBounty(bountyId).state), uint256(IBountyEscrow.State.Released));
    }

    function testEachStagedDepositRejectsTransferFeeAndSenderTaxTokens() public {
        (uint256[] memory amounts, uint64[] memory deadlines) = _schedule();

        FeeOnTransferERC20 feeToken = new FeeOnTransferERC20();
        feeToken.mint(requester, TOTAL);
        feeToken.setFeeEnabled(false);
        vm.prank(requester);
        feeToken.approve(address(escrow), TOTAL);
        vm.prank(requester);
        uint256 feeBountyId = escrow.createMilestoneBounty(
            address(feeToken), FIRST, amounts, deadlines, keccak256("fee scope"), provider, PROPOSAL_HASH
        );
        feeToken.setFeeEnabled(true);
        vm.expectRevert(
            abi.encodeWithSelector(
                IBountyEscrow.FundingAmountMismatch.selector, address(feeToken), SECOND, SECOND - (SECOND / 100)
            )
        );
        vm.prank(requester);
        escrow.fundMilestones(feeBountyId, 1);
        assertEq(escrow.fundedMilestoneCount(feeBountyId), 1);

        SenderTaxERC20 senderTaxToken = new SenderTaxERC20();
        senderTaxToken.mint(requester, TOTAL + (TOTAL / 100));
        senderTaxToken.setFeeEnabled(false);
        vm.prank(requester);
        senderTaxToken.approve(address(escrow), TOTAL);
        vm.prank(requester);
        uint256 taxBountyId = escrow.createMilestoneBounty(
            address(senderTaxToken), FIRST, amounts, deadlines, keccak256("tax scope"), provider, PROPOSAL_HASH
        );
        senderTaxToken.setFeeEnabled(true);
        vm.expectRevert(
            abi.encodeWithSelector(
                IBountyEscrow.FundingDebitMismatch.selector, address(senderTaxToken), SECOND, SECOND + (SECOND / 100)
            )
        );
        vm.prank(requester);
        escrow.fundMilestones(taxBountyId, 1);
        assertEq(escrow.fundedMilestoneCount(taxBountyId), 1);
    }

    function testFuzzPrefixFundingConservesLiability(uint96 rawFirst, uint96 rawSecond, uint96 rawThird) public {
        uint256 first = bound(uint256(rawFirst), 1, type(uint88).max);
        uint256 second = bound(uint256(rawSecond), 1, type(uint88).max);
        uint256 third = bound(uint256(rawThird), 1, type(uint88).max);
        uint256 total = first + second + third;

        BountyEscrow localEscrow = new BountyEscrow();
        MockERC20 localToken = new MockERC20();
        localToken.mint(requester, total);
        vm.prank(requester);
        localToken.approve(address(localEscrow), total);

        uint256[] memory amounts = new uint256[](3);
        amounts[0] = first;
        amounts[1] = second;
        amounts[2] = third;
        uint64[] memory deadlines = new uint64[](3);
        deadlines[0] = uint64(block.timestamp + 2 days);
        deadlines[1] = uint64(block.timestamp + 24 days);
        deadlines[2] = uint64(block.timestamp + 46 days);

        vm.prank(requester);
        uint256 bountyId = localEscrow.createMilestoneBounty(
            address(localToken), first, amounts, deadlines, keccak256("fuzz scope"), provider, PROPOSAL_HASH
        );
        assertEq(localEscrow.totalLiability(address(localToken)), first);
        assertEq(localToken.balanceOf(address(localEscrow)), first);

        vm.prank(requester);
        localEscrow.fundMilestones(bountyId, 2);
        assertEq(localEscrow.totalLiability(address(localToken)), total);
        assertEq(localToken.balanceOf(address(localEscrow)), total);
        assertEq(localEscrow.fundedMilestoneCount(bountyId), 3);
    }

    function _createFirstMilestoneFunded()
        private
        returns (uint256 bountyId, uint256[] memory amounts, uint64[] memory deadlines)
    {
        return _createWithFunding(FIRST);
    }

    function _createWithFunding(uint256 funding)
        private
        returns (uint256 bountyId, uint256[] memory amounts, uint64[] memory deadlines)
    {
        (amounts, deadlines) = _schedule();
        vm.prank(requester);
        bountyId = escrow.createMilestoneBounty(
            address(token), funding, amounts, deadlines, SCOPE_HASH, provider, PROPOSAL_HASH
        );
    }

    function _accept(uint256 bountyId) private {
        bytes32 termsHash = escrow.getBounty(bountyId).termsHash;
        vm.prank(provider);
        escrow.acceptBounty(bountyId, termsHash);
    }

    function _deliverApproveRelease(uint256 bountyId, uint256 salt) private {
        vm.prank(provider);
        escrow.submitDelivery(bountyId, keccak256(abi.encode("evidence", salt)));
        vm.prank(requester);
        escrow.approveDelivery(bountyId, keccak256(abi.encode("approval", salt)));
        vm.prank(caller);
        escrow.release(bountyId);
    }

    function _schedule() private view returns (uint256[] memory amounts, uint64[] memory deadlines) {
        amounts = new uint256[](3);
        amounts[0] = FIRST;
        amounts[1] = SECOND;
        amounts[2] = THIRD;
        deadlines = new uint64[](3);
        deadlines[0] = uint64(block.timestamp + 2 days);
        deadlines[1] = uint64(block.timestamp + 24 days);
        deadlines[2] = uint64(block.timestamp + 46 days);
    }
}

contract StagedFundingInvariantHandler is Test {
    BountyEscrow public immutable escrow;
    uint256 public immutable bountyId;
    address public immutable requester;
    address public immutable provider;
    uint32 public highestObservedFundedCount;

    constructor(BountyEscrow escrow_, uint256 bountyId_, address requester_, address provider_) {
        escrow = escrow_;
        bountyId = bountyId_;
        requester = requester_;
        provider = provider_;
        highestObservedFundedCount = escrow_.fundedMilestoneCount(bountyId_);
    }

    function fundThrough(uint8 rawTarget) external {
        IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        uint32 fundedCount = escrow.fundedMilestoneCount(bountyId);
        if (!_fundingState(bounty.state) || fundedCount >= bounty.milestoneCount) return;
        uint32 target = uint32(bound(uint256(rawTarget), fundedCount, bounty.milestoneCount - 1));
        IBountyEscrow.Milestone memory next = escrow.getMilestone(bountyId, fundedCount);
        if (block.timestamp >= next.deliveryDeadline) return;
        vm.prank(requester);
        escrow.fundMilestones(bountyId, target);
        highestObservedFundedCount = escrow.fundedMilestoneCount(bountyId);
    }

    function deliver(bytes32 evidence) external {
        IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        if (bounty.state != IBountyEscrow.State.ProviderAccepted || block.timestamp >= bounty.deliveryDeadline) return;
        if (evidence == bytes32(0)) evidence = bytes32(uint256(1));
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

    function release() external {
        IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        bool available = bounty.state == IBountyEscrow.State.BuyerApproved
            || (bounty.state == IBountyEscrow.State.Delivered && block.timestamp >= bounty.reviewDeadline);
        if (!available) return;
        escrow.release(bountyId);
    }

    function closeUnfunded() external {
        IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        if (bounty.state != IBountyEscrow.State.AwaitingFunding || block.timestamp < bounty.deliveryDeadline) return;
        escrow.closeUnfundedBounty(bountyId);
    }

    function advanceTime(uint32 rawSeconds) external {
        vm.warp(block.timestamp + bound(uint256(rawSeconds), 1, 10 days));
    }

    function _fundingState(IBountyEscrow.State state) private pure returns (bool) {
        return state == IBountyEscrow.State.Created || state == IBountyEscrow.State.Funded
            || state == IBountyEscrow.State.ProviderAccepted || state == IBountyEscrow.State.Delivered
            || state == IBountyEscrow.State.BuyerApproved || state == IBountyEscrow.State.AwaitingFunding;
    }
}

contract BountyEscrowStagedFundingInvariantTest is StdInvariant, Test {
    BountyEscrow internal escrow;
    MockERC20 internal token;
    StagedFundingInvariantHandler internal handler;
    uint256 internal bountyId;

    address internal requester = makeAddr("staged-invariant-requester");
    address internal provider = makeAddr("staged-invariant-provider");

    function setUp() public {
        escrow = new BountyEscrow();
        token = new MockERC20();
        token.mint(requester, 1_000 ether);
        vm.prank(requester);
        token.approve(address(escrow), type(uint256).max);

        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 200 ether;
        amounts[1] = 300 ether;
        amounts[2] = 500 ether;
        uint64[] memory deadlines = new uint64[](3);
        deadlines[0] = uint64(block.timestamp + 8 days);
        deadlines[1] = uint64(block.timestamp + 30 days);
        deadlines[2] = uint64(block.timestamp + 52 days);

        vm.prank(requester);
        bountyId = escrow.createMilestoneBounty(
            address(token),
            200 ether,
            amounts,
            deadlines,
            keccak256("staged invariant scope"),
            provider,
            keccak256("proposal")
        );
        bytes32 termsHash = escrow.getBounty(bountyId).termsHash;
        vm.prank(provider);
        escrow.acceptBounty(bountyId, termsHash);

        handler = new StagedFundingInvariantHandler(escrow, bountyId, requester, provider);
        targetContract(address(handler));
    }

    function invariantLiabilityEqualsFundedUnreleasedPrincipal() public view {
        IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        assertEq(escrow.totalLiability(address(token)), bounty.amount);
        assertEq(token.balanceOf(address(escrow)), bounty.amount);

        uint32 fundedCount = escrow.fundedMilestoneCount(bountyId);
        uint256 expectedPrincipal;
        for (uint256 i = bounty.currentMilestone; i < fundedCount; ++i) {
            IBountyEscrow.Milestone memory milestone = escrow.getMilestone(bountyId, i);
            if (milestone.state != IBountyEscrow.MilestoneState.Released) expectedPrincipal += milestone.amount;
        }
        assertEq(bounty.amount, expectedPrincipal);
    }

    function invariantFundingPrefixIsMonotonicAndBounded() public view {
        IBountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        uint32 fundedCount = escrow.fundedMilestoneCount(bountyId);
        assertGe(fundedCount, handler.highestObservedFundedCount());
        assertLe(fundedCount, bounty.milestoneCount);
        assertLe(bounty.currentMilestone, fundedCount);
    }
}
