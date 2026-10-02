// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAirSafetyLogView} from "./IAirSafetyLogView.sol";

/// @title SafetyIncentives
/// @notice Rewards device owners for reacting to incidents on time and slashes
///         late owners and a late relaying operator, using only facts already
///         anchored in AirSafetyLog (Token_incentive_task.md). Every rule is
///         permissionless; slashers earn a keeper share of the penalty.
/// @dev    AirSafetyLog is only read. The reward fund is the token balance not
///         owed to stakers (`balanceOf(this) - totalBonded`), so rewards can
///         never spend bonded tokens.
contract SafetyIncentives is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice Ack happened before the deadline (R1 recorded, paid or not).
    uint8 public constant TIMELY_ACK = 1;
    /// @notice R1 actually paid a reward; counts toward the daily cap and
    ///         unlocks R2.
    uint8 public constant ACK_REWARDED = 2;
    /// @notice R2 recorded (paid or skipped).
    uint8 public constant RESOLVE_SETTLED = 4;
    /// @notice P1 applied.
    uint8 public constant ACK_SLASHED = 8;
    /// @notice P2 applied.
    uint8 public constant RELAY_SLASHED = 16;

    /// @notice `deviceIdHash` used in bond events for the operator bond.
    bytes32 public constant OPERATOR_BOND_ID = bytes32(0);

    uint16 public constant BPS = 10_000;

    uint8 public constant RULE_ACK = 1;
    uint8 public constant RULE_RESOLVE = 2;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum SkipReason {
        DailyCap,
        InsufficientFund,
        NoBond,
        AckNotRewarded
    }

    struct Params {
        uint64 ackDeadlineWarning;
        uint64 ackDeadlineDanger;
        uint64 resolveDeadline;
        uint128 ownerBond;
        uint128 ackReward;
        uint128 resolveReward;
        uint128 missedAckPenalty;
        uint64 maxRelayDelay;
        uint128 lateRelayPenalty;
        uint16 keeperShareBps;
        uint8 dailyRewardCap;
        uint64 unstakeCooldown;
    }

    /// @param since Start of the current staking period; incidents logged
    ///        earlier are neither rewarded nor slashed against this bond.
    struct Bond {
        address staker;
        uint128 amount;
        uint64 since;
        uint64 unstakeRequestedAt;
    }

    /// @notice Everything the dApp and keeper need to decide what is callable.
    struct Settlement {
        bool exists;
        bool covered;
        bytes32 deviceIdHash;
        uint8 severity;
        uint8 status;
        uint64 observedAt;
        uint64 loggedAt;
        uint64 ackDeadline;
        uint64 resolveDeadline;
        uint64 relayDelay;
        uint8 flags;
        bool canRecordAck;
        bool canRecordResolve;
        bool canSlashMissedAck;
        bool canSlashLateRelay;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    IAirSafetyLogView public immutable airSafetyLog;
    IERC20 public immutable token;
    /// @notice Incidents logged before this timestamp are out of scope, so the
    ///         history anchored before deployment cannot be slashed.
    uint64 public immutable activatedAt;

    address public treasury;
    address public operator;

    Params private _params;
    mapping(bytes32 deviceIdHash => Bond) private _deviceBonds;
    Bond private _operatorBond;

    mapping(bytes32 incidentKey => uint8 flags) public settlementFlags;
    mapping(bytes32 deviceIdHash => mapping(uint64 day => uint8 count)) public rewardsToday;
    uint256 public totalBonded;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event Staked(bytes32 indexed deviceIdHash, address indexed staker, uint256 amount, uint256 total);
    event UnstakeRequested(bytes32 indexed deviceIdHash, address indexed staker, uint64 availableAt);
    event Withdrawn(bytes32 indexed deviceIdHash, address indexed staker, uint256 amount);
    event RewardsFunded(address indexed from, uint256 amount);

    event AckRewarded(bytes32 indexed incidentKey, address indexed owner, uint256 amount);
    event ResolveRewarded(bytes32 indexed incidentKey, address indexed owner, uint256 amount);
    event RewardSkipped(bytes32 indexed incidentKey, address indexed owner, uint8 rule, SkipReason reason);
    event MissedAckSlashed(
        bytes32 indexed incidentKey, bytes32 indexed deviceIdHash, uint256 amount, address indexed keeper
    );
    event LateRelaySlashed(bytes32 indexed incidentKey, uint64 delaySeconds, uint256 amount, address indexed keeper);
    event BondExhausted(bytes32 indexed deviceIdHash);

    event ParamsUpdated(Params params);
    event OperatorChanged(address indexed oldOperator, address indexed newOperator);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error InvalidParams();
    error IncidentNotFound(bytes32 incidentKey);
    error IncidentNotCovered(bytes32 incidentKey, uint64 loggedAt);
    error DeviceNotFound(bytes32 deviceIdHash);
    error NotDeviceOwner(address caller);
    error NotStaker(address caller);
    error NotOperator(address caller);
    error BondHeldByOther(address staker);
    error BondTooLow(uint256 total, uint256 minimum);
    error UnstakeAlreadyRequested();
    error NoUnstakeRequest();
    error CooldownActive(uint64 availableAt);
    error AlreadySettled(bytes32 incidentKey);
    error AckDeadlinePassed(bytes32 incidentKey, uint64 deadline);
    error AckDeadlineNotPassed(bytes32 incidentKey, uint64 deadline);
    error ResolveDeadlinePassed(bytes32 incidentKey, uint64 deadline);
    error NotAcknowledged(bytes32 incidentKey);
    error NotResolved(bytes32 incidentKey);
    error RelayNotLate(bytes32 incidentKey, uint64 delaySeconds);

    // ---------------------------------------------------------------------
    // Construction and admin
    // ---------------------------------------------------------------------

    constructor(address admin, address airSafetyLog_, address token_, address treasury_, address operator_) {
        if (
            admin == address(0) || airSafetyLog_ == address(0) || token_ == address(0) || treasury_ == address(0)
                || operator_ == address(0)
        ) revert ZeroAddress();
        airSafetyLog = IAirSafetyLogView(airSafetyLog_);
        token = IERC20(token_);
        activatedAt = uint64(block.timestamp);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);

        treasury = treasury_;
        emit TreasuryChanged(address(0), treasury_);
        operator = operator_;
        emit OperatorChanged(address(0), operator_);

        _setParams(
            Params({
                ackDeadlineWarning: 30 minutes,
                ackDeadlineDanger: 10 minutes,
                resolveDeadline: 24 hours,
                ownerBond: 100e18,
                ackReward: 5e18,
                resolveReward: 5e18,
                missedAckPenalty: 20e18,
                maxRelayDelay: 15 minutes,
                lateRelayPenalty: 20e18,
                keeperShareBps: 5_000,
                dailyRewardCap: 3,
                unstakeCooldown: 7 days
            })
        );
    }

    function setParams(Params calldata p) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setParams(p);
    }

    /// @notice Change the operator wallet. The operator bond stays in place and
    ///         now belongs to the new operator; a pending unstake is cancelled.
    function setOperator(address newOperator) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newOperator == address(0)) revert ZeroAddress();
        emit OperatorChanged(operator, newOperator);
        operator = newOperator;
        _operatorBond.unstakeRequestedAt = 0;
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryChanged(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Add tokens to the reward fund (needs a prior `approve`).
    function fundRewards(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit RewardsFunded(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Device bonds
    // ---------------------------------------------------------------------

    /// @notice Stake for a device. Only its current owner may stake; a bond
    ///         still held by a previous owner must be withdrawn first. Staking
    ///         again cancels a pending unstake.
    function stakeDevice(bytes32 deviceIdHash, uint128 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IAirSafetyLogView.Device memory dev = airSafetyLog.getDevice(deviceIdHash);
        if (!dev.exists) revert DeviceNotFound(deviceIdHash);
        if (dev.owner != msg.sender) revert NotDeviceOwner(msg.sender);

        Bond storage b = _deviceBonds[deviceIdHash];
        if (b.staker != msg.sender && b.amount != 0) revert BondHeldByOther(b.staker);
        if (b.amount == 0) {
            b.staker = msg.sender;
            b.since = uint64(block.timestamp);
        }
        uint128 total = b.amount + amount;
        if (total < _params.ownerBond) revert BondTooLow(total, _params.ownerBond);
        b.amount = total;
        b.unstakeRequestedAt = 0;
        totalBonded += amount;

        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(deviceIdHash, msg.sender, amount, total);
    }

    /// @notice Start the cooldown. The bond stops earning rewards but can still
    ///         be slashed until it is withdrawn.
    function requestUnstake(bytes32 deviceIdHash) external {
        Bond storage b = _deviceBonds[deviceIdHash];
        if (b.staker != msg.sender || b.amount == 0) revert NotStaker(msg.sender);
        emit UnstakeRequested(deviceIdHash, msg.sender, _requestUnstake(b));
    }

    function withdraw(bytes32 deviceIdHash) external nonReentrant {
        Bond storage b = _deviceBonds[deviceIdHash];
        if (b.staker != msg.sender) revert NotStaker(msg.sender);
        uint128 amount = _releaseAfterCooldown(b);
        delete _deviceBonds[deviceIdHash];
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(deviceIdHash, msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Operator bond
    // ---------------------------------------------------------------------

    /// @notice Anyone (normally the Treasury) may top up the operator bond.
    function depositOperatorBond(uint128 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _operatorBond.amount += amount;
        totalBonded += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(OPERATOR_BOND_ID, msg.sender, amount, _operatorBond.amount);
    }

    function requestOperatorUnstake() external {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        if (_operatorBond.amount == 0) revert ZeroAmount();
        emit UnstakeRequested(OPERATOR_BOND_ID, msg.sender, _requestUnstake(_operatorBond));
    }

    function withdrawOperator() external nonReentrant {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        uint128 amount = _releaseAfterCooldown(_operatorBond);
        delete _operatorBond;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(OPERATOR_BOND_ID, msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Rules
    // ---------------------------------------------------------------------

    /// @notice R1: record an acknowledgement made before the deadline and pay
    ///         the owner, within the device's daily cap.
    function recordTimelyAck(bytes32 incidentKey) external nonReentrant {
        IAirSafetyLogView.Incident memory inc = _loadCovered(incidentKey);
        uint8 f = settlementFlags[incidentKey];
        if (f & TIMELY_ACK != 0) revert AlreadySettled(incidentKey);
        uint64 deadline = _ackDeadline(inc);
        if (block.timestamp > deadline) revert AckDeadlinePassed(incidentKey, deadline);
        if (
            inc.status != IAirSafetyLogView.IncidentStatus.Acknowledged
                && inc.status != IAirSafetyLogView.IncidentStatus.Resolved
        ) revert NotAcknowledged(incidentKey);

        f |= TIMELY_ACK;
        address owner = airSafetyLog.getDevice(inc.deviceIdHash).owner;
        uint128 reward = _params.ackReward;
        uint64 day = currentDay();

        if (!_bondEarns(inc, owner)) {
            emit RewardSkipped(incidentKey, owner, RULE_ACK, SkipReason.NoBond);
        } else if (rewardsToday[inc.deviceIdHash][day] >= _params.dailyRewardCap) {
            emit RewardSkipped(incidentKey, owner, RULE_ACK, SkipReason.DailyCap);
        } else if (rewardFund() < reward) {
            emit RewardSkipped(incidentKey, owner, RULE_ACK, SkipReason.InsufficientFund);
        } else {
            f |= ACK_REWARDED;
            rewardsToday[inc.deviceIdHash][day] += 1;
            settlementFlags[incidentKey] = f;
            token.safeTransfer(owner, reward);
            emit AckRewarded(incidentKey, owner, reward);
            return;
        }
        settlementFlags[incidentKey] = f;
    }

    /// @notice R2: pay for a resolution before the resolve deadline. Only an
    ///         incident whose ack was rewarded (inside the daily cap) pays.
    function recordTimelyResolve(bytes32 incidentKey) external nonReentrant {
        IAirSafetyLogView.Incident memory inc = _loadCovered(incidentKey);
        uint8 f = settlementFlags[incidentKey];
        if (f & RESOLVE_SETTLED != 0) revert AlreadySettled(incidentKey);
        if (f & TIMELY_ACK == 0) revert NotAcknowledged(incidentKey);
        uint64 deadline = inc.loggedAt + _params.resolveDeadline;
        if (block.timestamp > deadline) revert ResolveDeadlinePassed(incidentKey, deadline);
        if (inc.status != IAirSafetyLogView.IncidentStatus.Resolved) revert NotResolved(incidentKey);

        f |= RESOLVE_SETTLED;
        settlementFlags[incidentKey] = f;
        address owner = airSafetyLog.getDevice(inc.deviceIdHash).owner;
        uint128 reward = _params.resolveReward;

        if (f & ACK_REWARDED == 0) {
            emit RewardSkipped(incidentKey, owner, RULE_RESOLVE, SkipReason.AckNotRewarded);
        } else if (!_bondEarns(inc, owner)) {
            emit RewardSkipped(incidentKey, owner, RULE_RESOLVE, SkipReason.NoBond);
        } else if (rewardFund() < reward) {
            emit RewardSkipped(incidentKey, owner, RULE_RESOLVE, SkipReason.InsufficientFund);
        } else {
            token.safeTransfer(owner, reward);
            emit ResolveRewarded(incidentKey, owner, reward);
        }
    }

    /// @notice P1: slash the owner's bond for an incident not acknowledged
    ///         before the deadline. A late ack does not avoid the penalty.
    function slashMissedAck(bytes32 incidentKey) external nonReentrant {
        IAirSafetyLogView.Incident memory inc = _loadCovered(incidentKey);
        uint8 f = settlementFlags[incidentKey];
        if (f & (TIMELY_ACK | ACK_SLASHED) != 0) revert AlreadySettled(incidentKey);
        uint64 deadline = _ackDeadline(inc);
        if (block.timestamp <= deadline) revert AckDeadlineNotPassed(incidentKey, deadline);
        settlementFlags[incidentKey] = f | ACK_SLASHED;

        Bond storage b = _deviceBonds[inc.deviceIdHash];
        uint128 penalty = _params.missedAckPenalty;
        uint128 taken;
        if (_bondCovers(b, inc, airSafetyLog.getDevice(inc.deviceIdHash).owner)) taken = _take(b, penalty);
        if (taken < penalty) emit BondExhausted(inc.deviceIdHash);
        emit MissedAckSlashed(incidentKey, inc.deviceIdHash, taken, msg.sender);
        _distribute(taken);
    }

    /// @notice P2: slash the operator bond when `loggedAt - observedAt` (the
    ///         device-signed observation time) exceeds the relay limit.
    function slashLateRelay(bytes32 incidentKey) external nonReentrant {
        IAirSafetyLogView.Incident memory inc = _loadCovered(incidentKey);
        uint8 f = settlementFlags[incidentKey];
        if (f & RELAY_SLASHED != 0) revert AlreadySettled(incidentKey);
        uint64 delay = _relayDelay(inc);
        if (delay <= _params.maxRelayDelay) revert RelayNotLate(incidentKey, delay);
        settlementFlags[incidentKey] = f | RELAY_SLASHED;

        uint128 penalty = _params.lateRelayPenalty;
        uint128 taken = _take(_operatorBond, penalty);
        if (taken < penalty) emit BondExhausted(OPERATOR_BOND_ID);
        emit LateRelaySlashed(incidentKey, delay, taken, msg.sender);
        _distribute(taken);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function params() external view returns (Params memory) {
        return _params;
    }

    function deviceBond(bytes32 deviceIdHash) external view returns (Bond memory) {
        return _deviceBonds[deviceIdHash];
    }

    function operatorBond() external view returns (Bond memory) {
        return _operatorBond;
    }

    /// @notice Tokens available for rewards (never includes bonded tokens).
    function rewardFund() public view returns (uint256) {
        uint256 balance = token.balanceOf(address(this));
        return balance > totalBonded ? balance - totalBonded : 0;
    }

    /// @notice UTC day index used by the daily reward cap.
    function currentDay() public view returns (uint64) {
        return uint64(block.timestamp / 1 days);
    }

    /// @notice Deadlines, flags and which rule calls would succeed right now.
    ///         Never reverts; `exists`/`covered` are false for unknown or
    ///         pre-activation incidents and every `can*` is then false.
    function pendingSettlement(bytes32 incidentKey) external view returns (Settlement memory s) {
        IAirSafetyLogView.Incident memory inc = airSafetyLog.getIncident(incidentKey);
        s.exists = inc.status != IAirSafetyLogView.IncidentStatus.None;
        if (!s.exists) return s;
        s.covered = inc.loggedAt >= activatedAt;
        s.deviceIdHash = inc.deviceIdHash;
        s.severity = inc.severity;
        s.status = uint8(inc.status);
        s.observedAt = inc.observedAt;
        s.loggedAt = inc.loggedAt;
        s.ackDeadline = _ackDeadline(inc);
        s.resolveDeadline = inc.loggedAt + _params.resolveDeadline;
        s.relayDelay = _relayDelay(inc);
        s.flags = settlementFlags[incidentKey];
        if (!s.covered) return s;

        bool acked = inc.status == IAirSafetyLogView.IncidentStatus.Acknowledged
            || inc.status == IAirSafetyLogView.IncidentStatus.Resolved;
        s.canRecordAck = s.flags & TIMELY_ACK == 0 && block.timestamp <= s.ackDeadline && acked;
        s.canRecordResolve = s.flags & TIMELY_ACK != 0 && s.flags & RESOLVE_SETTLED == 0
            && block.timestamp <= s.resolveDeadline && inc.status == IAirSafetyLogView.IncidentStatus.Resolved;
        s.canSlashMissedAck = s.flags & (TIMELY_ACK | ACK_SLASHED) == 0 && block.timestamp > s.ackDeadline;
        s.canSlashLateRelay = s.flags & RELAY_SLASHED == 0 && s.relayDelay > _params.maxRelayDelay;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _setParams(Params memory p) private {
        if (
            p.ackDeadlineWarning == 0 || p.ackDeadlineDanger == 0 || p.resolveDeadline < p.ackDeadlineWarning
                || p.resolveDeadline < p.ackDeadlineDanger || p.keeperShareBps > BPS
        ) revert InvalidParams();
        _params = p;
        emit ParamsUpdated(p);
    }

    function _loadCovered(bytes32 incidentKey) private view returns (IAirSafetyLogView.Incident memory inc) {
        inc = airSafetyLog.getIncident(incidentKey);
        if (inc.status == IAirSafetyLogView.IncidentStatus.None) revert IncidentNotFound(incidentKey);
        if (inc.loggedAt < activatedAt) revert IncidentNotCovered(incidentKey, inc.loggedAt);
    }

    /// @dev Warning uses the long deadline; danger (and a future critical
    ///      level) uses the short one.
    function _ackDeadline(IAirSafetyLogView.Incident memory inc) private view returns (uint64) {
        return inc.loggedAt + (inc.severity == 1 ? _params.ackDeadlineWarning : _params.ackDeadlineDanger);
    }

    function _relayDelay(IAirSafetyLogView.Incident memory inc) private pure returns (uint64) {
        return inc.loggedAt > inc.observedAt ? inc.loggedAt - inc.observedAt : 0;
    }

    /// @dev The bond answers for an incident only when it belongs to the
    ///      current owner and was in place when the incident was logged.
    function _bondCovers(Bond storage b, IAirSafetyLogView.Incident memory inc, address owner)
        private
        view
        returns (bool)
    {
        return b.staker == owner && b.amount != 0 && inc.loggedAt >= b.since;
    }

    /// @dev Rewards need a covering bond that is not leaving and can still pay
    ///      at least one missed-ack penalty.
    function _bondEarns(IAirSafetyLogView.Incident memory inc, address owner) private view returns (bool) {
        Bond storage b = _deviceBonds[inc.deviceIdHash];
        return _bondCovers(b, inc, owner) && b.unstakeRequestedAt == 0 && b.amount >= _params.missedAckPenalty;
    }

    function _requestUnstake(Bond storage b) private returns (uint64 availableAt) {
        if (b.unstakeRequestedAt != 0) revert UnstakeAlreadyRequested();
        b.unstakeRequestedAt = uint64(block.timestamp);
        availableAt = uint64(block.timestamp) + _params.unstakeCooldown;
    }

    function _releaseAfterCooldown(Bond storage b) private returns (uint128 amount) {
        if (b.unstakeRequestedAt == 0) revert NoUnstakeRequest();
        uint64 availableAt = b.unstakeRequestedAt + _params.unstakeCooldown;
        if (block.timestamp < availableAt) revert CooldownActive(availableAt);
        amount = b.amount;
        totalBonded -= amount;
    }

    function _take(Bond storage b, uint128 want) private returns (uint128 taken) {
        taken = b.amount < want ? b.amount : want;
        b.amount -= taken;
        totalBonded -= taken;
    }

    /// @dev Split a penalty between the caller (keeper bounty) and Treasury.
    function _distribute(uint128 amount) private {
        if (amount == 0) return;
        uint256 bounty = uint256(amount) * _params.keeperShareBps / BPS;
        if (bounty != 0) token.safeTransfer(msg.sender, bounty);
        if (amount > bounty) token.safeTransfer(treasury, amount - bounty);
    }
}
