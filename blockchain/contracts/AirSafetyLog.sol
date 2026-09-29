// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title AirSafetyLog
/// @notice Immutable on-chain trail for gas incidents signed by AIR devices
///         (docs/BLOCKCHAIN_INCIDENT_SCHEMA.md, Schema v2). The chain only
///         stores the minimal claim and the evidence hash; the full evidence
///         lives in TimescaleDB.
contract AirSafetyLog is AccessControl, EIP712 {
    // ---------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------

    /// @notice May register, rotate, revoke devices and change device owners.
    bytes32 public constant DEVICE_MANAGER_ROLE = keccak256("DEVICE_MANAGER_ROLE");
    /// @notice Backend relayer wallet allowed to submit signed incidents.
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    // ---------------------------------------------------------------------
    // Schema v2 constants
    // ---------------------------------------------------------------------

    uint16 public constant SCHEMA_VERSION = 2;

    uint8 public constant SEVERITY_WARNING = 1;
    uint8 public constant SEVERITY_DANGER = 2;
    uint8 public constant SEVERITY_CRITICAL = 3;

    bytes32 public constant EVIDENCE_TYPEHASH = keccak256(
        "IncidentEvidence(uint16 schemaVersion,bytes32 deviceIdHash,bytes32 incidentId,uint64 sequence,uint64 observedAt,uint8 timeSource,uint8 sensorValidMask,uint8 detectionMethod,int32 temperatureCx100,uint16 humidityPctX100,uint32 coPpmX1000,uint32 no2PpmX1000,uint8 overallLevel,uint8 coLevel,uint8 no2Level,uint8 coAlarmSourceMask,uint8 no2AlarmSourceMask,uint8 derivedValidMask,uint32 coStel15PpmX1000,uint32 no2Stel15PpmX1000,uint32 coTwa8hPpmX1000,uint32 no2Twa8hPpmX1000,uint32 coProj10PpmX1000,uint32 no2Proj10PpmX1000,uint8 modelProbabilityValidMask,uint16 coModelProbabilityBps,uint16 no2ModelProbabilityBps,uint8 incidentKind,uint8 severity,bytes32 firmwareVersionHash,bytes32 modelSha256,uint32 calibrationRevision,bytes32 calibrationHash)"
    );

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "IncidentAttestation(bytes32 deviceIdHash,bytes32 incidentId,uint64 sequence,uint64 observedAt,uint8 severity,bytes32 evidenceHash)"
    );

    /// @dev V2 incident ID prefix, keeps v2 IDs disjoint from v1.
    bytes internal constant INCIDENT_ID_PREFIX = "AIR-INCIDENT-2";

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Full canonical evidence (Schema v2 §4). Only used by the pure
    ///         helper `hashEvidence`; it is never stored on chain.
    struct IncidentEvidence {
        uint16 schemaVersion;
        bytes32 deviceIdHash;
        bytes32 incidentId;
        uint64 sequence;
        uint64 observedAt;
        uint8 timeSource;
        uint8 sensorValidMask;
        uint8 detectionMethod;
        int32 temperatureCx100;
        uint16 humidityPctX100;
        uint32 coPpmX1000;
        uint32 no2PpmX1000;
        uint8 overallLevel;
        uint8 coLevel;
        uint8 no2Level;
        uint8 coAlarmSourceMask;
        uint8 no2AlarmSourceMask;
        uint8 derivedValidMask;
        uint32 coStel15PpmX1000;
        uint32 no2Stel15PpmX1000;
        uint32 coTwa8hPpmX1000;
        uint32 no2Twa8hPpmX1000;
        uint32 coProj10PpmX1000;
        uint32 no2Proj10PpmX1000;
        uint8 modelProbabilityValidMask;
        uint16 coModelProbabilityBps;
        uint16 no2ModelProbabilityBps;
        uint8 incidentKind;
        uint8 severity;
        bytes32 firmwareVersionHash;
        bytes32 modelSha256;
        uint32 calibrationRevision;
        bytes32 calibrationHash;
    }

    /// @notice Minimal claim submitted by the relayer; identical to the
    ///         EIP-712 `IncidentAttestation` signed by the device.
    struct IncidentClaim {
        bytes32 deviceIdHash;
        bytes32 incidentId;
        uint64 sequence;
        uint64 observedAt;
        uint8 severity;
        bytes32 evidenceHash;
    }

    enum IncidentStatus {
        None,
        Logged,
        Acknowledged,
        Resolved
    }

    struct Device {
        address signer;
        address owner;
        uint64 lastSequence;
        bool hasLogged;
        bool active;
        bool exists;
    }

    struct Incident {
        bytes32 deviceIdHash;
        bytes32 incidentId;
        bytes32 evidenceHash;
        uint64 sequence;
        uint64 observedAt;
        uint64 loggedAt;
        uint8 severity;
        IncidentStatus status;
        address signer;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    mapping(bytes32 deviceIdHash => Device) private _devices;
    mapping(bytes32 incidentKey => Incident) private _incidents;
    /// @notice Exact anti-reuse history. Delivery order is not a validity rule:
    ///         an unseen lower sequence remains valid after a higher one arrives.
    mapping(bytes32 deviceIdHash => mapping(uint64 sequence => bool used)) public sequenceUsed;
    /// @notice A signer key can be bound to a device only once, ever.
    mapping(address signer => bool) public signerUsed;
    /// @notice Critical severity is rejected until a dedicated policy enables it.
    bool public criticalPolicyEnabled;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event DeviceRegistered(bytes32 indexed deviceIdHash, address indexed signer, address indexed owner);
    event DeviceSignerRotated(bytes32 indexed deviceIdHash, address indexed oldSigner, address indexed newSigner);
    event DeviceRevoked(bytes32 indexed deviceIdHash, address indexed signer);
    event DeviceOwnerChanged(bytes32 indexed deviceIdHash, address indexed oldOwner, address indexed newOwner);
    event CriticalPolicyChanged(bool enabled);

    event IncidentLogged(
        bytes32 indexed incidentKey,
        bytes32 indexed deviceIdHash,
        bytes32 indexed incidentId,
        uint64 sequence,
        uint64 observedAt,
        uint8 severity,
        bytes32 evidenceHash,
        address signer
    );
    event IncidentAcknowledged(bytes32 indexed incidentKey, bytes32 indexed deviceIdHash, address indexed owner);
    event IncidentResolved(bytes32 indexed incidentKey, bytes32 indexed deviceIdHash, address indexed owner);
    /// @notice Reserved for a future critical-severity policy; MVP has no producer.
    event EmergencyTriggered(bytes32 indexed incidentKey, bytes32 indexed deviceIdHash, uint64 observedAt);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error ZeroDeviceIdHash();
    error DeviceAlreadyActive(bytes32 deviceIdHash);
    error DeviceNotRegistered(bytes32 deviceIdHash);
    error DeviceNotActive(bytes32 deviceIdHash);
    error SignerAlreadyUsed(address signer);
    error InvalidSeverity(uint8 severity);
    error InvalidSequence(uint64 sequence);
    error ZeroEvidenceHash();
    error IncidentIdMismatch(bytes32 expected, bytes32 actual);
    error InvalidSignature();
    error WrongSigner(address expected, address actual);
    error IncidentAlreadyLogged(bytes32 incidentKey);
    error SequenceAlreadyUsed(bytes32 deviceIdHash, uint64 sequence);
    error IncidentNotFound(bytes32 incidentKey);
    error NotDeviceOwner(address caller);
    error InvalidStatus(IncidentStatus status);

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor(address admin) EIP712("AirSafetyLog", "1") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Device lifecycle
    // ---------------------------------------------------------------------

    /// @notice Register a new device, or re-provision a revoked one with a
    ///         fresh signer. Exact sequence-use history and the highest-seen
    ///         sequence metadata are preserved across re-provisioning.
    function registerDevice(bytes32 deviceIdHash, address signer, address owner)
        external
        onlyRole(DEVICE_MANAGER_ROLE)
    {
        if (deviceIdHash == bytes32(0)) revert ZeroDeviceIdHash();
        if (signer == address(0) || owner == address(0)) revert ZeroAddress();
        Device storage d = _devices[deviceIdHash];
        if (d.active) revert DeviceAlreadyActive(deviceIdHash);
        _claimSigner(signer);

        if (d.owner != owner) emit DeviceOwnerChanged(deviceIdHash, d.owner, owner);
        d.signer = signer;
        d.owner = owner;
        d.active = true;
        d.exists = true;
        emit DeviceRegistered(deviceIdHash, signer, owner);
    }

    /// @notice Replace the signer of an active device. Firmware must flush its
    ///         incident queue first: pending incidents signed by the old key
    ///         are rejected after rotation.
    function rotateSigner(bytes32 deviceIdHash, address newSigner) external onlyRole(DEVICE_MANAGER_ROLE) {
        if (newSigner == address(0)) revert ZeroAddress();
        Device storage d = _requireActive(deviceIdHash);
        _claimSigner(newSigner);
        address old = d.signer;
        d.signer = newSigner;
        emit DeviceSignerRotated(deviceIdHash, old, newSigner);
    }

    /// @notice Explicitly revoke a device signer after compromise, retirement
    ///         or decommissioning. Ordinary Wi-Fi/factory reset is not revoke.
    function revokeDevice(bytes32 deviceIdHash) external onlyRole(DEVICE_MANAGER_ROLE) {
        Device storage d = _requireActive(deviceIdHash);
        d.active = false;
        emit DeviceRevoked(deviceIdHash, d.signer);
    }

    function setDeviceOwner(bytes32 deviceIdHash, address newOwner) external onlyRole(DEVICE_MANAGER_ROLE) {
        if (newOwner == address(0)) revert ZeroAddress();
        Device storage d = _devices[deviceIdHash];
        if (!d.exists) revert DeviceNotRegistered(deviceIdHash);
        address old = d.owner;
        d.owner = newOwner;
        emit DeviceOwnerChanged(deviceIdHash, old, newOwner);
    }

    function setCriticalPolicyEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        criticalPolicyEnabled = enabled;
        emit CriticalPolicyChanged(enabled);
    }

    // ---------------------------------------------------------------------
    // Incidents
    // ---------------------------------------------------------------------

    /// @notice Anchor a device-signed incident claim. Called by the relayer.
    function logIncident(IncidentClaim calldata claim, bytes calldata signature)
        external
        onlyRole(RELAYER_ROLE)
        returns (bytes32 incidentKey)
    {
        Device storage d = _requireActive(claim.deviceIdHash);

        uint8 sev = claim.severity;
        if (sev != SEVERITY_WARNING && sev != SEVERITY_DANGER && !(sev == SEVERITY_CRITICAL && criticalPolicyEnabled)) {
            revert InvalidSeverity(sev);
        }
        if (claim.sequence == 0) revert InvalidSequence(claim.sequence);
        if (claim.evidenceHash == bytes32(0)) revert ZeroEvidenceHash();

        bytes32 expectedId = computeIncidentId(claim.deviceIdHash, claim.sequence);
        if (claim.incidentId != expectedId) revert IncidentIdMismatch(expectedId, claim.incidentId);

        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(attestationDigest(claim), signature);
        if (err != ECDSA.RecoverError.NoError) revert InvalidSignature();
        if (recovered != d.signer) revert WrongSigner(d.signer, recovered);

        incidentKey = computeIncidentKey(claim.deviceIdHash, claim.incidentId);
        if (_incidents[incidentKey].status != IncidentStatus.None) revert IncidentAlreadyLogged(incidentKey);
        if (sequenceUsed[claim.deviceIdHash][claim.sequence]) {
            revert SequenceAlreadyUsed(claim.deviceIdHash, claim.sequence);
        }

        sequenceUsed[claim.deviceIdHash][claim.sequence] = true;
        if (!d.hasLogged || claim.sequence > d.lastSequence) d.lastSequence = claim.sequence;
        d.hasLogged = true;
        _incidents[incidentKey] = Incident({
            deviceIdHash: claim.deviceIdHash,
            incidentId: claim.incidentId,
            evidenceHash: claim.evidenceHash,
            sequence: claim.sequence,
            observedAt: claim.observedAt,
            loggedAt: uint64(block.timestamp),
            severity: sev,
            status: IncidentStatus.Logged,
            signer: recovered
        });

        emit IncidentLogged(
            incidentKey,
            claim.deviceIdHash,
            claim.incidentId,
            claim.sequence,
            claim.observedAt,
            sev,
            claim.evidenceHash,
            recovered
        );
        if (sev == SEVERITY_CRITICAL) emit EmergencyTriggered(incidentKey, claim.deviceIdHash, claim.observedAt);
    }

    /// @notice Device owner acknowledges a logged incident.
    function acknowledgeIncident(bytes32 incidentKey) external {
        Incident storage inc = _requireOwnerOf(incidentKey);
        if (inc.status != IncidentStatus.Logged) revert InvalidStatus(inc.status);
        inc.status = IncidentStatus.Acknowledged;
        emit IncidentAcknowledged(incidentKey, inc.deviceIdHash, msg.sender);
    }

    /// @notice Device owner resolves a logged or acknowledged incident.
    function resolveIncident(bytes32 incidentKey) external {
        Incident storage inc = _requireOwnerOf(incidentKey);
        if (inc.status != IncidentStatus.Logged && inc.status != IncidentStatus.Acknowledged) {
            revert InvalidStatus(inc.status);
        }
        inc.status = IncidentStatus.Resolved;
        emit IncidentResolved(incidentKey, inc.deviceIdHash, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Views / pure helpers (shared with backend and app)
    // ---------------------------------------------------------------------

    function getDevice(bytes32 deviceIdHash) external view returns (Device memory) {
        return _devices[deviceIdHash];
    }

    function getIncident(bytes32 incidentKey) external view returns (Incident memory) {
        return _incidents[incidentKey];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function computeIncidentId(bytes32 deviceIdHash, uint64 sequence) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(INCIDENT_ID_PREFIX, deviceIdHash, sequence));
    }

    function computeIncidentKey(bytes32 deviceIdHash, bytes32 incidentId) public pure returns (bytes32) {
        return keccak256(abi.encode(deviceIdHash, incidentId));
    }

    /// @notice Schema v2 evidence struct hash. All fields are static, so
    ///         `abi.encode(typehash, e)` equals encoding every field in order.
    function hashEvidence(IncidentEvidence calldata e) external pure returns (bytes32) {
        return keccak256(abi.encode(EVIDENCE_TYPEHASH, e));
    }

    function hashAttestation(IncidentClaim calldata c) public pure returns (bytes32) {
        return keccak256(
            abi.encode(ATTESTATION_TYPEHASH, c.deviceIdHash, c.incidentId, c.sequence, c.observedAt, c.severity, c.evidenceHash)
        );
    }

    function attestationDigest(IncidentClaim calldata c) public view returns (bytes32) {
        return _hashTypedDataV4(hashAttestation(c));
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _claimSigner(address signer) private {
        if (signerUsed[signer]) revert SignerAlreadyUsed(signer);
        signerUsed[signer] = true;
    }

    function _requireActive(bytes32 deviceIdHash) private view returns (Device storage d) {
        d = _devices[deviceIdHash];
        if (!d.exists) revert DeviceNotRegistered(deviceIdHash);
        if (!d.active) revert DeviceNotActive(deviceIdHash);
    }

    function _requireOwnerOf(bytes32 incidentKey) private view returns (Incident storage inc) {
        inc = _incidents[incidentKey];
        if (inc.status == IncidentStatus.None) revert IncidentNotFound(incidentKey);
        if (_devices[inc.deviceIdHash].owner != msg.sender) revert NotDeviceOwner(msg.sender);
    }
}
