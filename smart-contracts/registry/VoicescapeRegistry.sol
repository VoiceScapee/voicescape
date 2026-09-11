// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title VoicescapeRegistry
/// @notice Maps normalized usernames to page owners + IPFS page content hashes,
///         with a human/agent owner-type distinction and agent disclosure.
/// @dev usernames are normalized to lowercase on write and read, so
///      "Brandon", "BRANDON" and "brandon" all refer to the same page.
///      EVM note: compiled for evmVersion "paris" (see hardhat.config.js)
///      because Hedera does not support Cancun-only opcodes.
contract VoicescapeRegistry {
    /// @notice HUMAN pages may omit disclosure; AGENT pages must disclose.
    /// @dev Numeric values are stable API: HUMAN = 0, AGENT = 1.
    enum OwnerType {
        HUMAN,
        AGENT
    }

    struct Page {
        address owner; // wallet that owns the page (receives tips)
        string ipfsHash; // CID of the page content JSON on IPFS
        OwnerType ownerType; // HUMAN or AGENT - immutable once set
        address operator; // AGENT pages: wallet/service operating the agent; 0x0 for humans
        string purpose; // AGENT pages: disclosed purpose/intent; "" for humans
    }

    // normalized (lowercase) username => Page
    mapping(string => Page) private pages;
    // normalized username => true once registered (never deleted, keeps uniqueness permanent)
    mapping(string => bool) private exists;

    event PageRegistered(
        string indexed username,
        address indexed owner,
        string ipfsHash,
        OwnerType ownerType,
        address operator,
        string purpose
    );
    event PageUpdated(
        string indexed username,
        address indexed owner,
        string ipfsHash,
        OwnerType ownerType,
        address operator,
        string purpose
    );

    error UsernameTaken(string username);
    error UsernameInvalid(string username);
    error NotPageOwner(string username, address caller);
    /// @notice Thrown when an AGENT page is registered without an operator
    ///         address and a non-empty purpose disclosure.
    error DisclosureRequired(string username);

    /// @notice Register a new page. Username must be unique (case-insensitive).
    /// @param username Human-readable handle, 3-32 chars of a-z 0-9 _ -
    /// @param ipfsHash CID pointing at the page content JSON
    /// @param ownerType HUMAN or AGENT. Immutable once set - no setter exists
    ///        and no code path may ever change it after registration.
    /// @param operator AGENT pages: the operator's address (must be non-zero).
    ///        Humans may pass address(0).
    /// @param purpose AGENT pages: a non-empty disclosure of the agent's
    ///        purpose. Humans may pass "".
    function registerPage(
        string calldata username,
        string calldata ipfsHash,
        OwnerType ownerType,
        address operator,
        string calldata purpose
    ) external {
        string memory name = _normalizeAndValidate(username);
        if (exists[name]) revert UsernameTaken(username);

        if (ownerType == OwnerType.AGENT) {
            if (operator == address(0) || bytes(purpose).length == 0)
                revert DisclosureRequired(username);
        }

        exists[name] = true;
        pages[name] = Page({
            owner: msg.sender,
            ipfsHash: ipfsHash,
            ownerType: ownerType,
            operator: operator,
            purpose: purpose
        });

        emit PageRegistered(
            name,
            msg.sender,
            ipfsHash,
            ownerType,
            operator,
            purpose
        );
    }

    /// @notice Update the IPFS hash of a page. Only the page owner may call.
    /// @dev Only owner + ipfsHash change here; ownerType, operator and
    ///      purpose are deliberately untouched (ownerType is immutable).
    /// @param username Normalized handle (case-insensitive lookup)
    /// @param ipfsHash New CID for the page content
    function updatePage(string calldata username, string calldata ipfsHash)
        external
    {
        string memory name = _normalizeAndValidate(username);
        if (!exists[name]) revert UsernameInvalid(username);
        Page storage page = pages[name];
        if (page.owner != msg.sender) revert NotPageOwner(username, msg.sender);

        page.ipfsHash = ipfsHash;

        emit PageUpdated(
            name,
            msg.sender,
            ipfsHash,
            page.ownerType,
            page.operator,
            page.purpose
        );
    }

    /// @notice Resolve a username to its full page record.
    /// @param username Handle (case-insensitive)
    /// @return owner Wallet that owns the page
    /// @return ipfsHash Current page content CID
    /// @return ownerType HUMAN or AGENT (immutable)
    /// @return operator Operator address (0x0 for human pages)
    /// @return purpose Agent purpose disclosure ("" for human pages)
    function resolvePage(string calldata username)
        external
        view
        returns (
            address owner,
            string memory ipfsHash,
            OwnerType ownerType,
            address operator,
            string memory purpose
        )
    {
        string memory name = _normalizeAndValidate(username);
        if (!exists[name]) revert UsernameInvalid(username);
        Page storage page = pages[name];
        return (
            page.owner,
            page.ipfsHash,
            page.ownerType,
            page.operator,
            page.purpose
        );
    }

    /// @notice Check whether a username is already registered (case-insensitive).
    function usernameExists(string calldata username)
        external
        view
        returns (bool)
    {
        // validate length/charset but do NOT revert on taken-ness here;
        // an invalid name simply cannot exist.
        try this.validateUsername(username) returns (string memory name) {
            return exists[name];
        } catch {
            return false;
        }
    }

    /// @notice Pure helper: normalize + validate a username, exposed for reuse
    ///         (e.g. by the frontend via eth_call before registering).
    /// @return name Lowercase, validated username
    function validateUsername(string calldata username)
        external
        pure
        returns (string memory name)
    {
        return _normalizeAndValidate(username);
    }

    // ---------- internal ----------

    /// @dev Lowercases ASCII A-Z and validates 3-32 chars of [a-z0-9_-].
    function _normalizeAndValidate(string memory username)
        internal
        pure
        returns (string memory name)
    {
        bytes memory raw = bytes(username);
        if (raw.length < 3 || raw.length > 32) revert UsernameInvalid(username);

        bytes memory out = new bytes(raw.length);
        for (uint256 i = 0; i < raw.length; i++) {
            bytes1 c = raw[i];
            // uppercase ASCII -> lowercase
            if (c >= 0x41 && c <= 0x5A) {
                c = bytes1(uint8(c) + 32);
            }
            bool ok = (c >= 0x61 && c <= 0x7A) || // a-z
                (c >= 0x30 && c <= 0x39) || // 0-9
                c == 0x5F || // _
                c == 0x2D; // -
            if (!ok) revert UsernameInvalid(username);
            out[i] = c;
        }
        return string(out);
    }
}
