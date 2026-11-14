// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console} from "forge-std/Script.sol";
import {Semaphore} from "@semaphore-protocol/contracts/Semaphore.sol";
import {SemaphoreVerifier} from "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol";
import {ISemaphoreVerifier} from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";

/// @notice Deploys Semaphore v4 (unmodified, from the npm package) on a chain that
///         doesn't have an official deployment, e.g. Arc.
///
///         Three contracts end up on-chain:
///           - PoseidonT3 (external library used by the LeanIMT Merkle tree). Forge
///             deploys and links it automatically because it is not pre-linked.
///           - SemaphoreVerifier (Groth16 verifier, needs the BN254 precompiles 0x06-0x08).
///           - Semaphore.
///
///         Because this is our own deployment, voters can't check the address against
///         Semaphore's official list. They should instead check that the verified source
///         on the explorer matches the npm package semaphore-protocol/contracts 4.14.5.
///
/// Usage:
///   forge script script/DeploySemaphore.s.sol --rpc-url $RPC --private-key $PK --broadcast
contract DeploySemaphore is Script {
    function run() external returns (Semaphore semaphore, SemaphoreVerifier verifier) {
        vm.startBroadcast();
        verifier = new SemaphoreVerifier();
        semaphore = new Semaphore(ISemaphoreVerifier(address(verifier)));
        vm.stopBroadcast();

        console.log("SemaphoreVerifier:", address(verifier));
        console.log("Semaphore:        ", address(semaphore));
    }
}
