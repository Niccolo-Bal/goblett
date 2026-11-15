const { ethers } = require('ethers');

// Leaf format, shared with the contract and the static allowlist:
// keccak256(abi.encodePacked(address)) — the raw 20-byte address, not the 32-byte ABI word.
// Internal nodes match OpenZeppelin MerkleProof: keccak256 of the pair, smaller hash first.
function leafFor(address) {
  return ethers.keccak256(ethers.getBytes(ethers.getAddress(address)));
}

function hashPair(left, right) {
  const ordered = BigInt(left) < BigInt(right) ? [left, right] : [right, left];
  return ethers.keccak256(ethers.concat(ordered));
}

function buildTree(addresses) {
  const unique = [...new Set(addresses.map((address) => ethers.getAddress(address)))];
  const leaves = unique.map(leafFor).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  if (!leaves.length) {
    return { root: ethers.ZeroHash, proofs: {} };
  }

  const layers = [leaves];
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 === level.length ? level[i] : hashPair(level[i], level[i + 1]));
    }
    layers.push(next);
    level = next;
  }

  const proofs = {};
  unique.forEach((address) => {
    const leaf = leafFor(address);
    let index = leaves.findIndex((item) => item === leaf);
    const proof = [];
    for (let layer = 0; layer < layers.length - 1; layer++) {
      const sibling = index ^ 1;
      if (sibling < layers[layer].length) proof.push(layers[layer][sibling]);
      index = Math.floor(index / 2);
    }
    proofs[address.toLowerCase()] = proof;
  });

  return { root: level[0], proofs };
}

function verifyProof(root, address, proof) {
  let computed = leafFor(address);
  for (const sibling of proof || []) computed = hashPair(computed, sibling);
  return computed.toLowerCase() === String(root).toLowerCase();
}

module.exports = { leafFor, hashPair, buildTree, verifyProof };
