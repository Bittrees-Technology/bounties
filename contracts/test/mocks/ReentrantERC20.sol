// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BountyEscrow} from "../../src/BountyEscrow.sol";

contract ReentrantERC20 is ERC20 {
    BountyEscrow private _target;
    bool private _armed;

    constructor() ERC20("Reentrant Test Token", "RTT") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function arm(BountyEscrow target) external {
        _target = target;
        _armed = true;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (_armed) {
            _armed = false;
            _target.createBounty(address(this), 0, 0);
        }
        return super.transferFrom(from, to, value);
    }
}

