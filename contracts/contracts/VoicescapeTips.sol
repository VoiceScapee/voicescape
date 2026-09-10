// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title VoicescapeTips
/// @notice Accepts native-currency tips for registered pages AND settles
///         marketplace purchases, splitting every payment 98% to the
///         recipient (page owner / seller) and 2% to the platform treasury.
///         The contract NEVER holds buyer funds: every payment is split
///         atomically inside a single transaction — there is no escrow,
///         no locking, no custody. Delivery of purchased goods happens
///         off-chain.
/// @dev Dependency-free (no OpenZeppelin) so it compiles standalone.
///      Follows checks-effects-interactions: state is read up front, no
///      contract state is written after the external calls in tipPage, and
///      the event is emitted last. low-level `call` is used (instead of
///      transfer) so the recipient can be any contract or EOA on
///      Hedera/Polygon, and both calls are checked for success.
interface IVoicescapeRegistry {
    // Full tuple declared deliberately: VoicescapeRegistry.resolvePage
    // returns (owner, ipfsHash, ownerType, operator, purpose). Declaring only
    // a prefix would work via positional ABI decoding but silently depend on
    // field order, so pin all five fields here.
    // ownerType is VoicescapeRegistry.OwnerType (HUMAN = 0, AGENT = 1).
    function resolvePage(string calldata username)
        external
        view
        returns (
            address owner,
            string memory ipfsHash,
            uint8 ownerType,
            address operator,
            string memory purpose
        );
}

contract VoicescapeTips {
    // Fee is 2% = 200 basis points.
    uint256 public constant FEE_BPS = 200;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    IVoicescapeRegistry public immutable registry;
    address public owner; // deployer; can point treasury elsewhere
    address public treasury; // receives the 2% platform fee

    event TipSent(
        string indexed username,
        address indexed from,
        address indexed toOwner,
        uint256 amount, // total tipped (wei)
        uint256 fee // treasury cut (wei)
    );
    /// @notice Emitted when a marketplace listing is bought. The payment is
    ///         settled atomically in the same transaction — the contract
    ///         never holds buyer funds.
    event PurchaseCompleted(
        address indexed buyer,
        address indexed seller,
        string listingRef,
        uint256 amount, // total paid (wei)
        uint256 fee // treasury cut (wei)
    );
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    error ZeroTip();
    error ZeroPurchase();
    error InvalidSeller();
    error TipFailed(address recipient, uint256 amount);
    error NotOwner(address caller);
    error InvalidAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    /// @param registryAddress Deployed VoicescapeRegistry contract
    /// @param treasuryAddress Wallet/contract receiving the 2% platform fee
    constructor(address registryAddress, address treasuryAddress) {
        if (registryAddress == address(0) || treasuryAddress == address(0))
            revert InvalidAddress();
        registry = IVoicescapeRegistry(registryAddress);
        treasury = treasuryAddress;
        owner = msg.sender;
    }

    /// @notice Tip a page. 98% goes to the page owner, 2% to the treasury.
    /// @param username Page handle (resolved case-insensitively via registry)
    function tipPage(string calldata username) external payable {
        if (msg.value == 0) revert ZeroTip();

        // CHECKS: resolve the page first; reverts if the username is unknown.
        (address pageOwner, , , , ) = registry.resolvePage(username);

        uint256 fee = (msg.value * FEE_BPS) / BPS_DENOMINATOR;
        uint256 ownerShare = msg.value - fee;

        // EFFECTS: no contract state to update before the external calls;
        // (all state is immutable/owner-controlled, so there is nothing to
        //  corrupt on reentry beyond this function's local values.)

        // INTERACTIONS: push funds last, checking both calls.
        (bool okOwner, ) = payable(pageOwner).call{value: ownerShare}("");
        if (!okOwner) revert TipFailed(pageOwner, ownerShare);

        (bool okTreasury, ) = payable(treasury).call{value: fee}("");
        if (!okTreasury) revert TipFailed(treasury, fee);

        emit TipSent(username, msg.sender, pageOwner, msg.value, fee);
    }

    /// @notice Buy a marketplace listing. 98% goes to the seller and 2% to
    ///         the treasury ATOMICALLY, in this single transaction — the
    ///         contract never holds the buyer's funds for any length of
    ///         time. `listingRef` is the off-chain listing id (emitted for
    ///         indexing; delivery of the goods happens off-chain).
    /// @param seller The seller's payout address (0x…).
    /// @param listingRef Off-chain marketplace listing reference.
    function buyListing(address seller, string calldata listingRef) external payable {
        if (msg.value == 0) revert ZeroPurchase();
        if (seller == address(0)) revert InvalidSeller();

        uint256 fee = (msg.value * FEE_BPS) / BPS_DENOMINATOR;
        uint256 sellerShare = msg.value - fee;

        // INTERACTIONS: push funds, checking both calls. No contract state
        // is written, so there is nothing to corrupt on reentry.
        (bool okSeller, ) = payable(seller).call{value: sellerShare}("");
        if (!okSeller) revert TipFailed(seller, sellerShare);

        (bool okTreasury, ) = payable(treasury).call{value: fee}("");
        if (!okTreasury) revert TipFailed(treasury, fee);

        emit PurchaseCompleted(msg.sender, seller, listingRef, msg.value, fee);
    }

    /// @notice Point the fee at a new treasury. Deployer-only.
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidAddress();
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }
}
