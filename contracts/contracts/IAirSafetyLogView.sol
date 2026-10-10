// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Read-only slice of AirSafetyLog (Schema v2) used by SafetyIncentives.
///         Struct layouts must match AirSafetyLog exactly; the deployed log is
///         never modified.
interface IAirSafetyLogView {
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

    function getDevice(bytes32 deviceIdHash) external view returns (Device memory);

    function getIncident(bytes32 incidentKey) external view returns (Incident memory);
}
