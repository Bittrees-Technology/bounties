// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {BountyEscrow} from "../src/BountyEscrow.sol";

/// @notice Unexecuted deployment template. Supplying `--broadcast` is an operator action.
contract DeployBountyEscrow is Script {
    error InvalidReviewToken(address token);

    function run() external returns (BountyEscrow escrow, address reviewToken) {
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address arbiter = vm.envAddress("ARBITER_ADDRESS");
        address guardian = vm.envAddress("GUARDIAN_ADDRESS");
        reviewToken = vm.envAddress("TOKEN_ADDRESS");
        if (reviewToken == address(0)) revert InvalidReviewToken(reviewToken);

        vm.startBroadcast();
        escrow = new BountyEscrow(admin, arbiter, guardian);
        vm.stopBroadcast();
    }
}

