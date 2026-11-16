const { callElection } = require('./election-call');
const { validateRelayedEvent } = require('./validate-nostr');

// The relayer calls settleVote with each published vote.
// info: { npub, note, votes, event }

async function validateVote(info) {
  if (!info || !info.event) throw new Error('Publish the vote to Nostr before validating it.');
  return validateRelayedEvent(info.event, {
    pubkey: info.event.pubkey,
    note: info.note
  });
}

async function callSolidity(info, validation) {
  return callElection(info, validation);
}

async function settleVote(info) {
  const validation = await validateVote(info);
  const chain = await callSolidity(info, validation);
  return { validation, chain };
}

module.exports = { settleVote, validateVote, callSolidity };
