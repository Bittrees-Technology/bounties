// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract FeeOnTransferERC20 is ERC20 {
    uint256 public constant feeBps = 100;
    address public immutable feeSink = address(0xdead);

    constructor() ERC20("Fee On Transfer Test Token", "FOT") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (from == address(0) || to == address(0) || value == 0) {
            super._update(from, to, value);
            return;
        }

        uint256 fee = (value * feeBps) / 10_000;
        uint256 net = value - fee;
        if (fee != 0) super._update(from, feeSink, fee);
        super._update(from, to, net);
    }
}
