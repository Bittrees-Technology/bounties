// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {BountyEscrow} from "../../src/BountyEscrow.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract BountyEscrowFundingFuzzTest is Test {
    BountyEscrow internal escrow;
    MockERC20 internal token;
    address internal requester = makeAddr("fuzz-requester");

    function setUp() public {
        escrow = new BountyEscrow(address(this), makeAddr("arbiter"), makeAddr("guardian"));
        token = new MockERC20();
        token.mint(requester, type(uint128).max);
        vm.prank(requester);
        token.approve(address(escrow), type(uint256).max);
    }

    /// @dev For every positive uint96 deposit, accounting equals custody and state is Funded.
    function testFuzzFundingAmount(uint96 rawAmount) public {
        uint256 amount = bound(rawAmount, 1, type(uint96).max);

        vm.prank(requester);
        uint256 bountyId = escrow.createBounty(address(token), amount, 0);

        BountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
        assertEq(bounty.amount, amount);
        assertEq(token.balanceOf(address(escrow)), amount);
        assertEq(uint256(bounty.state), uint256(BountyEscrow.State.Funded));
    }
}

