const { fetchEvent, relayUrls } = require('./nostr');

function taggedGoblett(event) {
  return (event.tags || []).some((tag) => tag[0] === 't' && tag[1] === 'goblett');
}

function unsignedCopy(event) {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig
  };
}

async function validateRelayedEvent(event, expected) {
  if (!event || !event.id || !event.pubkey || !event.sig) {
    throw new Error('The Nostr event is incomplete.');
  }
  const { verifyEvent } = await import('nostr-tools/pure');
  if (!verifyEvent(unsignedCopy(event))) throw new Error('The Nostr signature is not valid.');
  if (event.kind !== 1) throw new Error('The Nostr event is not a note.');
  if (!taggedGoblett(event)) throw new Error('The Nostr event is not tagged goblett.');
  if (expected && expected.pubkey && event.pubkey !== expected.pubkey) {
    throw new Error('The Nostr event is from a different key.');
  }
  if (expected && expected.note != null && event.content !== expected.note) {
    throw new Error('The Nostr event does not match this vote.');
  }

  const stored = await fetchEvent(event.id, relayUrls());
  if (!stored || stored.id !== event.id) {
    throw new Error('No Nostr relay returned this event.');
  }
  if (!verifyEvent(unsignedCopy(stored))) throw new Error('The event stored on the relay has a bad signature.');
  if (stored.content !== event.content || stored.pubkey !== event.pubkey) {
    throw new Error('The event stored on the relay does not match the published vote.');
  }
  return {
    eventId: event.id,
    pubkey: event.pubkey,
    note: event.content
  };
}

module.exports = { validateRelayedEvent };
