// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Minimal ERC-1271 contract wallet: accepts any signature for a digest
///         the test has approved, rejects everything else.
contract MockERC1271Wallet {
    bytes4 internal constant MAGIC = 0x1626ba7e;

    mapping(bytes32 => bool) public approved;

    function approve(bytes32 digest) external {
        approved[digest] = true;
    }

    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return approved[digest] ? MAGIC : bytes4(0xffffffff);
    }
}
