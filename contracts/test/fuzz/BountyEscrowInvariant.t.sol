// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {BountyEscrow} from "../../src/BountyEscrow.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract BountyEscrowHandler is Test {
    BountyEscrow public immutable escrow;
    MockERC20 public immutable token;
    address public immutable requester;
    address public immutable provider;
    address public immutable arbiter;
    uint256 public immutable bountyId;

    constructor(
        BountyEscrow escrow_,
        MockERC20 token_,
        address requester_,
        address provider_,
        address arbiter_,
        uint256 bountyId_
    ) {
        escrow = escrow_;
        token = token_;
        requester = requester_;
        provider = provider_;
        arbiter = arbiter_;
        bountyId = bountyId_;
    }

    function assign() external {
        if (escrow.getBounty(bountyId).state != BountyEscrow.State.Funded) return;
        vm.prank(requester);
        escrow.assignBounty(bountyId, provider);
    }

    function deliver() external {
        if (escrow.getBounty(bountyId).state != BountyEscrow.State.Assigned) return;
        vm.prank(provider);
        escrow.markDelivered(bountyId);
    }

    function accept() external {
        if (escrow.getBounty(bountyId).state != BountyEscrow.State.Delivered) return;
        vm.prank(requester);
        escrow.acceptDelivery(bountyId);
    }

    function release() external {
        if (escrow.getBounty(bountyId).state != BountyEscrow.State.Accepted) return;
        escrow.release(bountyId);
    }

    function dispute() external {
        BountyEscrow.State state = escrow.getBounty(bountyId).state;
        if (state != BountyEscrow.State.Assigned && state != BountyEscrow.State.Delivered) return;
        vm.prank(requester);
        escrow.raiseDispute(bountyId);
    }

    function resolve(uint256 providerAward) external {
        BountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        if (bounty.state != BountyEscrow.State.Disputed) return;
        providerAward = bound(providerAward, 0, bounty.amount);
        vm.prank(arbiter);
        escrow.resolveDispute(bountyId, providerAward);
    }

    function cancel() external {
        BountyEscrow.State state = escrow.getBounty(bountyId).state;
        if (state != BountyEscrow.State.Created && state != BountyEscrow.State.Funded) return;
        vm.prank(requester);
        escrow.cancelBounty(bountyId);
    }
}

contract BountyEscrowInvariantTest is StdInvariant, Test {
    BountyEscrow internal escrow;
    MockERC20 internal token;
    BountyEscrowHandler internal handler;

    address internal requester = makeAddr("requester");
    address internal provider = makeAddr("provider");
    address internal arbiter = makeAddr("arbiter");
    address internal guardian = makeAddr("guardian");

    uint256 internal constant AMOUNT = 1_000 ether;
    uint256 internal bountyId;

    function setUp() public {
        escrow = new BountyEscrow(address(this), arbiter, guardian);
        token = new MockERC20();
        token.mint(requester, AMOUNT);

        vm.startPrank(requester);
        token.approve(address(escrow), AMOUNT);
        bountyId = escrow.createBounty(address(token), AMOUNT, 0);
        vm.stopPrank();

        handler = new BountyEscrowHandler(escrow, token, requester, provider, arbiter, bountyId);
        targetContract(address(handler));
    }

    function invariant_escrowBalanceMatchesRecordedLiability() public view {
        BountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        assertEq(token.balanceOf(address(escrow)), bounty.amount);
    }

    function invariant_terminalStatesHaveNoEscrowLiability() public view {
        BountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        bool terminal = bounty.state == BountyEscrow.State.Released || bounty.state == BountyEscrow.State.Refunded
            || bounty.state == BountyEscrow.State.Resolved;
        if (terminal) assertEq(bounty.amount, 0);
    }

    function invariant_payoutsNeverExceedOriginalFunding() public view {
        uint256 distributed = token.balanceOf(requester) + token.balanceOf(provider);
        assertLe(distributed, AMOUNT);
    }
}
