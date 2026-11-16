const fs = require('fs');
const path = require('path');
const { networkById, publishDeployment } = require('./networks');

const id = process.argv[2];
if (!id) {
  console.error('Usage: node scripts/use-network.js local|testnet|mainnet');
  process.exit(1);
}
networkById(id);
const file = path.join(__dirname, '..', 'contracts', 'deployments', id + '.json');
if (!fs.existsSync(file)) {
  console.error('Deploy ' + id + ' before switching to it.');
  process.exit(1);
}
const record = JSON.parse(fs.readFileSync(file, 'utf8'));
publishDeployment(record);
console.log('Pages and the relayer now use ' + record.id + ' at ' + record.ledger);
