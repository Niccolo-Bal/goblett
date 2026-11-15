async function electionsFor(voting, voter) {
  const count = Number(await voting.ELECTION_COUNT());
  const elections = [];
  for (let id = 0; id < count; id++) {
    elections.push({
      id: String(id),
      name: await voting.electionName(id),
      whitelisted: await voting.whitelisted(id, voter)
    });
  }
  return elections;
}

async function assertWhitelisted(voting, voter, questionIds) {
  const perElection = Number(await voting.QUESTIONS_PER_ELECTION());
  const checked = new Set();
  for (const questionId of questionIds) {
    const electionId = Math.floor(Number(questionId) / perElection);
    if (checked.has(electionId)) continue;
    checked.add(electionId);
    if (!(await voting.whitelisted(electionId, voter))) {
      const name = await voting.electionName(electionId);
      throw new Error('This wallet is not whitelisted for the ' + name + ' election.');
    }
  }
}

module.exports = { electionsFor, assertWhitelisted };
