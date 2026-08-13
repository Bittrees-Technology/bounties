// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Deliberately hostile token: transferFrom spends allowance for `value` but debits an
/// additional sender tax while crediting the recipient the full requested amount.
contract SenderTaxERC20 is ERC20 {
    uint256 public constant feeBps = 100;
    address public immutable feeSink = address(0xdead);
    bool public feeEnabled = true;

    constructor() ERC20("Sender Tax Test Token", "STAX") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function setFeeEnabled(bool enabled) external {
        feeEnabled = enabled;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (!feeEnabled || from == address(0) || to == address(0) || value == 0) {
            super._update(from, to, value);
            return;
        }

        super._update(from, to, value);
        super._update(from, feeSink, (value * feeBps) / 10_000);
    }
}
