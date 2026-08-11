// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract RebasingERC20 is ERC20 {
    constructor() ERC20("Rebasing Test Token", "RBT") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function slash(address holder, uint256 amount) external {
        _update(holder, address(0), amount);
    }
}
