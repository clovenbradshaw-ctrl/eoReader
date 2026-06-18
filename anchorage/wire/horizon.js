// σ (sigma) DSL: four cases for collapsing a stack of DEFs at a target down
// to a single projected value. Switching σ is live; no re-extraction needed.
//
//   latest            — newest by ts
//   source_priority   — priority list of agent prefixes
//   agent_priority    — priority list of exact agent strings
//   manual            — explicit map from target -> def_id
//
// All cases except `latest` fall through to `latest` when the priority/choice
// yields no match.

function byNewest(a, b) { return (b.ts || '').localeCompare(a.ts || ''); }

export function projectDef(stack, horizon) {
  if (!stack || stack.length === 0) return null;
  const sigma = horizon && horizon.sigma || 'latest';
  switch (sigma) {
    case 'latest':
      return stack.slice().sort(byNewest)[0];
    case 'source_priority': {
      for (const prefix of horizon.priority || []) {
        const winner = stack.slice().sort(byNewest).find(d => (d.agent || '').startsWith(prefix));
        if (winner) return winner;
      }
      return projectDef(stack, { sigma: 'latest' });
    }
    case 'agent_priority': {
      for (const agent of horizon.priority || []) {
        const winner = stack.slice().sort(byNewest).find(d => d.agent === agent);
        if (winner) return winner;
      }
      return projectDef(stack, { sigma: 'latest' });
    }
    case 'manual': {
      const target = stack[0] && stack[0].target;
      const chosenId = horizon.choice && horizon.choice[target];
      if (!chosenId) return projectDef(stack, { sigma: 'latest' });
      return stack.find(d => d.id === chosenId) || projectDef(stack, { sigma: 'latest' });
    }
    default:
      throw new Error('unknown horizon.sigma: ' + sigma);
  }
}
