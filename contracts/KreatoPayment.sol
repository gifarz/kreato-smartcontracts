// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title KreatoPayment
 * @notice Splits every payment between the creator and Kreato platform.
 *         Fee is hardcoded at 250 basis points (2.5%).
 *
 * Supported payment types:
 *   1. Native ETH
 *   2. ERC-20 tokens (USDC, USDT, etc.)
 *
 * Flow:
 *   Buyer approves token spend → calls payWithToken(...)
 *   Contract splits:  creator gets 97.5%, platform gets 2.5%
 */
contract KreatoPayment is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Constants ─────────────────────────────────────────────────────────────
    uint256 public constant FEE_BPS = 250;          // 2.5% in basis points
    uint256 public constant BPS_DENOMINATOR = 10000;

    // Platform fee recipient — hardcoded, not immutable
    address public PLATFORM_WALLET;
    address public OWNER;

    constructor(address _platformWallet) {
        OWNER = msg.sender;
        PLATFORM_WALLET = _platformWallet;
    }

    // ── Events ────────────────────────────────────────────────────────────────

    event PaymentProcessed(
        address indexed buyer,
        address indexed creator,
        address indexed token,   // address(0) for ETH
        uint256 totalAmount,
        uint256 creatorAmount,
        uint256 platformFee,
        bytes32 productId,       // off-chain reference (keccak256 of Kreato product id)
        PaymentType paymentType
    );

    enum PaymentType { PURCHASE, DONATION, SUBSCRIPTION }

    // ── Update Platform Wallet ───────────────────────────────────────────────────────────
    function setPlatformWallet(address _new) external {
        require(msg.sender == OWNER, "Not owner");
        require(_new != address(0), "Invalid address");
        PLATFORM_WALLET = _new;
    }

    // ── ETH payment ───────────────────────────────────────────────────────────

    /**
     * @notice Pay with native ETH.
     * @param creator   Address of the creator to receive funds.
     * @param productId Off-chain product/membership id (bytes32 encoded).
     * @param pType     Payment type (PURCHASE / DONATION / SUBSCRIPTION).
     */
    function payWithETH(
        address payable creator,
        bytes32 productId,
        PaymentType pType
    ) external payable nonReentrant {
        require(msg.value > 0, "KreatoPayment: amount must be > 0");
        require(creator != address(0), "KreatoPayment: invalid creator address");
        require(creator != PLATFORM_WALLET, "KreatoPayment: creator cannot be platform");

        uint256 totalAmount  = msg.value;
        uint256 platformFee  = (totalAmount * FEE_BPS) / BPS_DENOMINATOR;
        uint256 creatorAmount = totalAmount - platformFee;

        // Transfer to creator
        (bool sentCreator, ) = creator.call{ value: creatorAmount }("");
        require(sentCreator, "KreatoPayment: ETH transfer to creator failed");

        // Transfer fee to platform
        (bool sentPlatform, ) = payable(PLATFORM_WALLET).call{ value: platformFee }("");
        require(sentPlatform, "KreatoPayment: ETH transfer to platform failed");

        emit PaymentProcessed(
            msg.sender,
            creator,
            address(0),
            totalAmount,
            creatorAmount,
            platformFee,
            productId,
            pType
        );
    }

    // ── ERC-20 payment ────────────────────────────────────────────────────────

    /**
     * @notice Pay with an ERC-20 token (USDC, USDT, etc.).
     *         Caller must have approved this contract for `amount` tokens first.
     * @param token     ERC-20 token contract address.
     * @param amount    Total amount in token's smallest unit (e.g. 1_000_000 for 1 USDC).
     * @param creator   Address of the creator to receive funds.
     * @param productId Off-chain product/membership id (bytes32 encoded).
     * @param pType     Payment type (PURCHASE / DONATION / SUBSCRIPTION).
     */
    function payWithToken(
        address token,
        uint256 amount,
        address creator,
        bytes32 productId,
        PaymentType pType
    ) external nonReentrant {
        require(amount > 0, "KreatoPayment: amount must be > 0");
        require(token != address(0), "KreatoPayment: invalid token address");
        require(creator != address(0), "KreatoPayment: invalid creator address");
        require(creator != PLATFORM_WALLET, "KreatoPayment: creator cannot be platform");

        uint256 platformFee   = (amount * FEE_BPS) / BPS_DENOMINATOR;
        uint256 creatorAmount = amount - platformFee;

        IERC20 erc20 = IERC20(token);

        // Pull full amount from buyer to this contract first
        // (SafeERC20 handles tokens that don't return bool)
        erc20.safeTransferFrom(msg.sender, address(this), amount);

        // Forward to creator
        erc20.safeTransfer(creator, creatorAmount);

        // Forward fee to platform
        erc20.safeTransfer(PLATFORM_WALLET, platformFee);

        emit PaymentProcessed(
            msg.sender,
            creator,
            token,
            amount,
            creatorAmount,
            platformFee,
            productId,
            pType
        );
    }

    // ── View helpers ──────────────────────────────────────────────────────────

    /**
     * @notice Calculate the split for a given amount.
     * @return creatorAmount Amount creator receives.
     * @return platformFee   Amount platform receives.
     */
    function calculateSplit(uint256 amount)
        external
        pure
        returns (uint256 creatorAmount, uint256 platformFee)
    {
        platformFee   = (amount * FEE_BPS) / BPS_DENOMINATOR;
        creatorAmount = amount - platformFee;
    }

    // ── Safety: reject plain ETH sends ───────────────────────────────────────

    receive() external payable {
        revert("KreatoPayment: use payWithETH()");
    }

    fallback() external payable {
        revert("KreatoPayment: use payWithETH()");
    }
}
