# Hardhat voting demo

The page submits each selected Yes/No answer as a batch to the `Voting` contract on a local Hardhat network. Each wallet can vote once per question. The contract stores yes/no totals and emits a `VoteCast` event for every answer.

## Run locally

1. Install the project dependencies with `npm install`.
2. Start the local chain with `npm run node` and leave it running.
3. In another terminal, deploy the contract with `npm run deploy:local`. Copy the printed contract address.
4. In your wallet, add a local network at `http://127.0.0.1:8545` with chain ID `31337`. Import one of the test accounts printed by the Hardhat node; these accounts are for local development only.
5. Open `main.html`, enter the deployed contract address in the bottom bar, select answers, and submit. Confirm the transaction in your wallet.

The page uses ethers.js from jsDelivr and requires a browser wallet such as MetaMask. Do not use Hardhat test accounts or this demo contract with real funds.