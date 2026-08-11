// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {IBountyEscrow} from "../../src/IBountyEscrow.sol";

contract ReentrantERC20 is ERC20 {
    enum CallbackMode {
        None,
        Create,
        Release,
        Settlement
    }

    IBountyEscrow private _target;
    CallbackMode private _mode;
    uint256 private _bountyId;
    uint256 private _providerPayout;
    bytes32 private _scopeHash;
    address private _provider;
    bytes32 private _proposalHash;

    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor() ERC20("Reentrant Test Token", "RTT") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function armCreate(IBountyEscrow target, bytes32 scopeHash, address provider, bytes32 proposalHash) external {
        _target = target;
        _mode = CallbackMode.Create;
        _scopeHash = scopeHash;
        _provider = provider;
        _proposalHash = proposalHash;
    }

    function armRelease(IBountyEscrow target, uint256 bountyId) external {
        _target = target;
        _mode = CallbackMode.Release;
        _bountyId = bountyId;
    }

    function armSettlement(IBountyEscrow target, uint256 bountyId, uint256 providerPayout) external {
        _target = target;
        _mode = CallbackMode.Settlement;
        _bountyId = bountyId;
        _providerPayout = providerPayout;
    }

    function disarm() external {
        _mode = CallbackMode.None;
        _target = IBountyEscrow(address(0));
        _bountyId = 0;
        _providerPayout = 0;
        _scopeHash = bytes32(0);
        _provider = address(0);
        _proposalHash = bytes32(0);
    }

    function resetFlags() external {
        reentryAttempted = false;
        reentrySucceeded = false;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        _maybeReenter();
        return super.transferFrom(from, to, value);
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        _maybeReenter();
        return super.transfer(to, value);
    }

    function _maybeReenter() internal {
        if (_mode == CallbackMode.None) return;

        reentryAttempted = true;
        if (_mode == CallbackMode.Create) {
            try _target.createBounty(address(this), 0, 0, _scopeHash, _provider, _proposalHash) {
                reentrySucceeded = true;
            } catch {}
        } else if (_mode == CallbackMode.Release) {
            try _target.release(_bountyId) {
                reentrySucceeded = true;
            } catch {}
        } else if (_mode == CallbackMode.Settlement) {
            try _target.acceptSettlement(_bountyId, _providerPayout) {
                reentrySucceeded = true;
            } catch {}
        }

        _mode = CallbackMode.None;
    }
}
