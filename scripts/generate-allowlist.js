const fs = require('fs');
const path = require('path');
const { buildTree } = require('./merkle');

const source = path.join(__dirname, '..', 'allowlist-addresses.json');
const target = path.join(__dirname, '..', 'allowlist.json');
const addresses = JSON.parse(fs.readFileSync(source, 'utf8'));
const tree = buildTree(addresses);

fs.writeFileSync(target, JSON.stringify({
  leaf: 'keccak256(abi.encodePacked(address))',
  root: tree.root,
  proofs: tree.proofs
}, null, 2) + '\n');

console.log('Wrote', target);
console.log('Merkle root:', tree.root);
console.log('The contract owner sets this root with setMerkleRoot.');
