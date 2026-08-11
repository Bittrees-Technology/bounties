// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract RecipientBlockingERC20 is ERC20 {
    error RecipientBlocked(address recipient);

    address public blockedRecipient;
    bool public blockingEnabled;

    constructor() ERC20("Recipient Blocking Test Token", "RBT") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function setBlockedRecipient(address recipient, bool enabled) external {
        blockedRecipient = recipient;
        blockingEnabled = enabled;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blockingEnabled && from != address(0) && to == blockedRecipient) {
            revert RecipientBlocked(to);
        }
        super._update(from, to, value);
    }
}
