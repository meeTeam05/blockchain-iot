// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title AirSafeToken (ASAFE)
/// @notice Testnet-only incentive token for SafetyIncentives. The whole supply
///         is minted once to the Treasury; there is no mint, burn or pause, so
///         the total supply never changes and every reward or penalty is a
///         transfer between wallets.
contract AirSafeToken is ERC20 {
    uint256 public constant INITIAL_SUPPLY = 1_000_000e18;

    error ZeroAddress();

    constructor(address treasury) ERC20("AirSafe Token", "ASAFE") {
        if (treasury == address(0)) revert ZeroAddress();
        _mint(treasury, INITIAL_SUPPLY);
    }
}
