// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only ERC-20 whose next transfer calls back into `target` with
///         `payload`, bubbling up any revert. Used to prove SafetyIncentives
///         rejects reentrancy from a malicious token.
contract ReentrantToken is ERC20 {
    address private _target;
    bytes private _payload;

    constructor(address holder, uint256 supply) ERC20("Reentrant", "REE") {
        _mint(holder, supply);
    }

    function arm(address target, bytes calldata payload) external {
        _target = target;
        _payload = payload;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        address target = _target;
        if (target == address(0)) return;
        _target = address(0);
        (bool ok, bytes memory ret) = target.call(_payload);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
