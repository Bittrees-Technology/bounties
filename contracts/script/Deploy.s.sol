// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {BountyEscrow} from "../src/BountyEscrow.sol";

/// @notice Local simulation template. This script contains no signer or broadcast instruction.
contract DeployBountyEscrow is Script {
    function run() external returns (BountyEscrow escrow) {
        escrow = new BountyEscrow();
    }
}
