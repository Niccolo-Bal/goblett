// The ballots the page records. Names match the headings on the ballot.
const ballots = [
  { section: 'State', name: 'Prop A', mode: 0, options: ['Yes', 'No'] },
  { section: 'State', name: 'Prop B', mode: 0, options: ['Yes', 'No'] },
  { section: 'State', name: 'Pick one candidate', mode: 1, options: ['Candidate A', 'Candidate B', 'Candidate C', 'Candidate D'] },
  { section: 'Federal', name: 'Rank the candidates', mode: 2, options: ['Candidate A', 'Candidate B', 'Candidate C', 'Candidate D'] }
];

function encodeVotes(votes) {
  const byName = new Map(ballots.map((ballot, index) => [ballot.name, index]));
  const ballotIds = [];
  const choiceCounts = [];
  const choices = [];
  const seen = new Set();
  (votes || []).forEach((vote) => {
    const name = String(vote && vote.name || '').trim();
    const id = byName.get(name);
    if (id == null) throw new Error('Unknown ballot: ' + name);
    if (seen.has(id)) throw new Error('The ballot was submitted twice: ' + name);
    seen.add(id);
    const ballot = ballots[id];
    const indexes = (Array.isArray(vote.choices) ? vote.choices : []).map((label) => {
      const wanted = String(label).trim().toLowerCase();
      const at = ballot.options.findIndex((option) => option.toLowerCase() === wanted);
      if (at < 0) throw new Error('Unknown choice ' + label + ' for ' + name);
      return at;
    });
    ballotIds.push(id);
    choiceCounts.push(indexes.length);
    indexes.forEach((index) => choices.push(index));
  });
  if (!ballotIds.length) throw new Error('Select at least one answer.');
  return { ballotIds, choiceCounts, choices };
}

module.exports = { ballots, encodeVotes };
