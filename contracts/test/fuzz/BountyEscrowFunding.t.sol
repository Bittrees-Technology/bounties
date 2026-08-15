// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {BountyEscrow} from "../../src/BountyEscrow.sol";
import {IBountyEscrow} from "../../src/IBountyEscrow.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract BountyEscrowFundingFuzzTest is Test {
    BountyEscrow internal escrow;
    MockERC20 internal token;

    address internal requester = makeAddr("fuzz-requester");
    bytes32 internal constant METADATA_HASH = keccak256("fuzz-metadata");
    bytes32 internal constant PROPOSAL_HASH = keccak256("fuzz-proposal");

    function setUp() public {
        escrow = new BountyEscrow();
        token = new MockERC20();
        token.mint(requester, type(uint128).max);
        vm.prank(requester);
        token.approve(address(escrow), type(uint256).max);
    }

    function testFuzzAtomicCreateAndFund(uint96 rawAmount, uint32 rawDelay) public {
        uint256 amount = bound(rawAmount, 1, type(uint96).max);
        uint64 deadline = uint64(block.timestamp + bound(uint256(rawDelay), 1, 30 days));
        address provider = makeAddr("fuzz-provider");
        bytes32 scopeHash = _scopeHash(amount, deadline, bytes32(uint256(1)));
        bytes32 termsHash = _termsHash(scopeHash, provider);

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);

        BountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        assertEq(address(bounty.token), address(token));
        assertEq(bounty.amount, amount);
        assertEq(bounty.deliveryDeadline, deadline);
        assertEq(bounty.scopeHash, scopeHash);
        assertEq(bounty.provider, provider);
        assertEq(bounty.proposalHash, PROPOSAL_HASH);
        assertEq(bounty.termsHash, termsHash);
        assertEq(uint256(bounty.state), uint256(IBountyEscrow.State.Funded));
        assertEq(escrow.totalLiability(address(token)), amount);
        assertEq(token.balanceOf(address(escrow)), amount);
    }

    function testFuzzCreationReplayCannotPullPrincipalTwice(uint96 rawAmount, uint32 rawDelay) public {
        uint256 amount = bound(rawAmount, 1, type(uint96).max);
        uint64 deadline = uint64(block.timestamp + bound(uint256(rawDelay), 1, 30 days));
        address provider = makeAddr("fuzz-replay-provider");
        bytes32 scopeHash = _scopeHash(amount, deadline, bytes32(uint256(2)));
        bytes32 termsHash = _termsHash(scopeHash, provider);

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);
        uint256 requesterBalance = token.balanceOf(requester);
        uint256 escrowBalance = token.balanceOf(address(escrow));

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.DuplicateBounty.selector, requester, termsHash, bountyId));
        vm.prank(requester);
        escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);

        assertEq(escrow.nextBountyId(), bountyId + 1);
        assertEq(token.balanceOf(requester), requesterBalance);
        assertEq(token.balanceOf(address(escrow)), escrowBalance);
        assertEq(escrow.totalLiability(address(token)), amount);
    }

    function testFuzzUnfundedRecordThenExactFunding(uint96 rawAmount, uint32 rawDelay) public {
        uint256 amount = bound(rawAmount, 1, type(uint96).max);
        uint64 deadline = uint64(block.timestamp + bound(uint256(rawDelay), 1, 30 days));
        address provider = makeAddr("fuzz-provider");
        bytes32 scopeHash = _scopeHash(amount, deadline, bytes32(uint256(3)));
        bytes32 termsHash = _termsHash(scopeHash, provider);

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), 0, deadline, scopeHash, provider, PROPOSAL_HASH);

        vm.prank(requester);
        escrow.fundBounty(bountyId, amount);

        BountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        assertEq(uint256(bounty.state), uint256(IBountyEscrow.State.Funded));
        assertEq(bounty.amount, amount);
        assertEq(bounty.provider, provider);
        assertEq(bounty.proposalHash, PROPOSAL_HASH);
        assertEq(bounty.termsHash, termsHash);
        assertEq(escrow.totalLiability(address(token)), amount);
    }

    function testFuzzFundedCancellationBeforeProviderAcceptanceReturnsExactPrincipal(uint96 rawAmount, uint32 rawDelay)
        public
    {
        uint256 amount = bound(rawAmount, 1, type(uint96).max);
        uint64 deadline = uint64(block.timestamp + bound(uint256(rawDelay), 1, 30 days));
        address provider = makeAddr("cancellation-fuzz-provider");
        bytes32 scopeHash = _scopeHash(amount, deadline, bytes32(uint256(4)));

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);
        uint256 requesterBalanceAfterFunding = token.balanceOf(requester);

        vm.prank(requester);
        escrow.cancelBounty(bountyId);

        BountyEscrow.Bounty memory cancelled = escrow.getBounty(bountyId);
        assertEq(uint256(cancelled.state), uint256(IBountyEscrow.State.Cancelled));
        assertEq(cancelled.amount, 0);
        assertEq(token.balanceOf(requester), requesterBalanceAfterFunding + amount);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalLiability(address(token)), 0);
    }

    function testFuzzRefundBoundary(uint96 rawAmount, uint32 rawDelay) public {
        uint256 amount = bound(rawAmount, 1, type(uint96).max);
        uint64 deadline = uint64(block.timestamp + bound(uint256(rawDelay), 1, 30 days));
        address provider = makeAddr("fuzz-provider");
        bytes32 scopeHash = _scopeHash(amount, deadline, bytes32(uint256(5)));
        bytes32 termsHash = _termsHash(scopeHash, provider);

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);
        vm.prank(provider);
        escrow.acceptBounty(bountyId, termsHash);

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.RefundNotAvailable.selector, bountyId, deadline));
        vm.prank(requester);
        escrow.refundBounty(bountyId);

        vm.warp(deadline);

        vm.prank(requester);
        escrow.refundBounty(bountyId);

        BountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        assertEq(uint256(bounty.state), uint256(IBountyEscrow.State.Refunded));
        assertEq(bounty.amount, 0);
        assertEq(escrow.totalLiability(address(token)), 0);
    }

    function testFuzzFundedRefundBoundaryWithoutProviderAcceptance(uint96 rawAmount, uint32 rawDelay) public {
        uint256 amount = bound(rawAmount, 1, type(uint96).max);
        uint64 deadline = uint64(block.timestamp + bound(uint256(rawDelay), 1, 30 days));
        address provider = makeAddr("unresponsive-fuzz-provider");
        bytes32 scopeHash = _scopeHash(amount, deadline, bytes32(uint256(6)));

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);

        vm.expectRevert(abi.encodeWithSelector(IBountyEscrow.RefundNotAvailable.selector, bountyId, deadline));
        escrow.refundBounty(bountyId);

        vm.warp(deadline);
        escrow.refundBounty(bountyId);

        BountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        assertEq(uint256(bounty.state), uint256(IBountyEscrow.State.Refunded));
        assertEq(bounty.amount, 0);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalLiability(address(token)), 0);
    }

    function testFuzzSevenDayReviewReleaseBoundary(uint96 rawAmount, uint32 rawDelay) public {
        uint256 amount = bound(rawAmount, 1, type(uint96).max);
        uint64 deadline = uint64(block.timestamp + bound(uint256(rawDelay), 1, 30 days));
        address provider = makeAddr("fuzz-provider");
        address caller = makeAddr("permissionless-release-caller");
        bytes32 scopeHash = _scopeHash(amount, deadline, bytes32(uint256(7)));
        bytes32 termsHash = _termsHash(scopeHash, provider);

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);
        vm.prank(provider);
        escrow.acceptBounty(bountyId, termsHash);
        vm.prank(provider);
        escrow.submitDelivery(bountyId, keccak256(abi.encode(rawAmount, rawDelay)));

        BountyEscrow.Bounty memory delivered = escrow.getBounty(bountyId);
        assertEq(delivered.reviewDeadline, uint64(block.timestamp) + 7 days);

        vm.warp(delivered.reviewDeadline - 1);
        vm.expectRevert(
            abi.encodeWithSelector(IBountyEscrow.ReviewPeriodActive.selector, bountyId, delivered.reviewDeadline)
        );
        vm.prank(caller);
        escrow.release(bountyId);

        vm.warp(delivered.reviewDeadline);
        vm.prank(caller);
        escrow.release(bountyId);

        BountyEscrow.Bounty memory released = escrow.getBounty(bountyId);
        assertEq(uint256(released.state), uint256(IBountyEscrow.State.Released));
        assertEq(released.amount, 0);
        assertEq(token.balanceOf(provider), amount);
        assertEq(escrow.totalLiability(address(token)), 0);
    }

    function testFuzzBilateralSettlementConservesPrincipal(
        uint96 rawAmount,
        uint96 rawProviderPayout,
        bool providerProposes
    ) public {
        uint256 amount = bound(rawAmount, 1, type(uint96).max);
        uint256 providerPayout = bound(rawProviderPayout, 0, amount);
        address provider = makeAddr("fuzz-provider");
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 scopeHash = _scopeHash(amount, deadline, bytes32(uint256(9)));

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);

        address proposer = providerProposes ? provider : requester;
        address acceptor = providerProposes ? requester : provider;
        vm.prank(proposer);
        escrow.proposeSettlement(bountyId, providerPayout);
        vm.prank(acceptor);
        escrow.acceptSettlement(bountyId, providerPayout);

        BountyEscrow.Bounty memory settled = escrow.getBounty(bountyId);
        assertEq(uint256(settled.state), uint256(IBountyEscrow.State.Settled));
        assertEq(settled.amount, 0);
        assertEq(settled.settlementProposer, address(0));
        assertEq(settled.proposedProviderPayout, 0);
        assertEq(settled.settlementProposalExpiry, 0);
        assertEq(token.balanceOf(provider), providerPayout);
        assertEq(token.balanceOf(requester), type(uint128).max - providerPayout);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalLiability(address(token)), 0);
    }

    function testFuzzSettlementProposalExpiryIsBoundedAndProposerCanCancel(
        uint96 rawAmount,
        uint96 rawProviderPayout,
        uint32 rawDelay,
        bool providerProposes,
        uint8 rawState
    ) public {
        uint256 amount = bound(rawAmount, 1, type(uint96).max);
        uint256 providerPayout = bound(rawProviderPayout, 0, amount);
        uint64 deadline = uint64(block.timestamp + bound(uint256(rawDelay), 1, 30 days));
        address provider = makeAddr("expiry-fuzz-provider");
        bytes32 scopeHash = _scopeHash(amount, deadline, bytes32(uint256(10)));
        address proposer = providerProposes ? provider : requester;

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), amount, deadline, scopeHash, provider, PROPOSAL_HASH);
        uint8 targetState = rawState % 4;
        if (targetState >= 1) {
            bytes32 termsHash = _termsHash(scopeHash, provider);
            vm.prank(provider);
            escrow.acceptBounty(bountyId, termsHash);
        }
        if (targetState >= 2) {
            vm.prank(provider);
            escrow.submitDelivery(bountyId, keccak256(abi.encode("settlement-expiry", rawState)));
        }
        if (targetState >= 3) {
            vm.prank(requester);
            escrow.approveDelivery(bountyId, keccak256(abi.encode("settlement-approval", rawState)));
        }
        uint64 maximumExpiry = uint64(block.timestamp) + escrow.SETTLEMENT_PROPOSAL_PERIOD();
        vm.prank(proposer);
        escrow.proposeSettlement(bountyId, providerPayout);

        IBountyEscrow.Bounty memory proposed = escrow.getBounty(bountyId);
        assertGt(proposed.settlementProposalExpiry, block.timestamp);
        assertLe(proposed.settlementProposalExpiry, maximumExpiry);
        if (targetState < 2) {
            assertLe(proposed.settlementProposalExpiry, deadline);
        } else if (targetState == 2) {
            assertLe(proposed.settlementProposalExpiry, proposed.reviewDeadline);
        }

        vm.warp(proposed.settlementProposalExpiry);
        vm.expectRevert(
            abi.encodeWithSelector(
                IBountyEscrow.SettlementProposalExpired.selector, bountyId, proposed.settlementProposalExpiry
            )
        );
        vm.prank(providerProposes ? requester : provider);
        escrow.acceptSettlement(bountyId, providerPayout);

        vm.prank(proposer);
        escrow.cancelSettlementProposal(bountyId);
        IBountyEscrow.Bounty memory cancelled = escrow.getBounty(bountyId);
        assertEq(cancelled.settlementProposer, address(0));
        assertEq(cancelled.proposedProviderPayout, 0);
        assertEq(cancelled.settlementProposalExpiry, 0);
        assertEq(uint256(cancelled.state), uint256(proposed.state));
        assertEq(cancelled.amount, amount);
    }

    function _scopeHash(uint256 plannedAmount, uint64 deadline, bytes32 salt) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                escrow.SCOPE_DOMAIN(),
                block.chainid,
                address(escrow),
                requester,
                address(token),
                plannedAmount,
                deadline,
                METADATA_HASH,
                salt
            )
        );
    }

    function _termsHash(bytes32 scopeHash, address selectedProvider) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                escrow.TERMS_DOMAIN(), block.chainid, address(escrow), scopeHash, PROPOSAL_HASH, selectedProvider
            )
        );
    }
}
