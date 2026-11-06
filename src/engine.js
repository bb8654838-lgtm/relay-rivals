export const COLORS = ['#ff6b4a', '#52d9c5', '#a78bfa', '#f6c85f'];
export const MAX_ROUNDS = 6;
export const TARGET_SCORE = 15;
export const TURN_MS = 20_000;
export const MAX_ENERGY = 8;

const HOME_NODES = {
  2: ['r0', 'r6'],
  3: ['r0', 'r4', 'r8'],
  4: ['r0', 'r3', 'r6', 'r9'],
};

function makeBoard() {
  const nodes = Array.from({ length: 12 }, (_, index) => ({
    id: `r${index}`,
    label: `Relay ${index + 1}`,
    kind: 'relay',
    value: 1,
    owner: null,
    units: 1,
    shield: 0,
    neighbors: [`r${(index + 11) % 12}`, `r${(index + 1) % 12}`, 'core'],
  }));
  nodes.push({
    id: 'core',
    label: 'The Core',
    kind: 'core',
    value: 3,
    owner: null,
    units: 3,
    shield: 1,
    neighbors: Array.from({ length: 12 }, (_, index) => `r${index}`),
  });
  return { nodes, coreId: 'core' };
}

export function createGame(playerSpecs, now = Date.now()) {
  if (!Array.isArray(playerSpecs) || playerSpecs.length < 2 || playerSpecs.length > 4) {
    throw new Error('A match requires 2-4 players');
  }

  const board = makeBoard();
  const homes = HOME_NODES[playerSpecs.length];
  const players = playerSpecs.map((player, seat) => ({
    id: player.id,
    name: player.name,
    seat,
    isBot: Boolean(player.isBot),
    color: COLORS[seat],
    score: 0,
    energy: 4,
    homeNode: homes[seat],
  }));

  players.forEach(player => {
    const home = board.nodes.find(node => node.id === player.homeNode);
    home.owner = player.id;
    home.units = 4;
  });

  return {
    version: 1,
    status: 'active',
    players,
    board,
    round: 1,
    maxRounds: MAX_ROUNDS,
    targetScore: TARGET_SCORE,
    turnIndex: 0,
    turnNumber: 0,
    currentSeat: 0,
    turnStartedAt: now,
    turnDeadline: now + TURN_MS,
    log: [],
    replay: [],
    winner: null,
  };
}

export function getLegalMoves(game, playerId) {
  if (game.status !== 'active') return [];
  const player = game.players[game.currentSeat];
  if (!player || player.id !== playerId) return [];

  const owned = game.board.nodes.filter(node => node.owner === playerId);
  const moves = [];

  if (player.energy < MAX_ENERGY) moves.push({ type: 'focus' });

  for (const node of owned) {
    for (let units = 1; units <= Math.min(3, player.energy); units += 1) {
      moves.push({ type: 'deploy', node: node.id, units });
    }
  }

  if (player.energy >= 2) {
    for (const node of owned.filter(candidate => candidate.shield < 4)) {
      moves.push({ type: 'fortify', node: node.id });
    }
  }

  for (const source of owned.filter(node => node.units > 1)) {
    for (const target of source.neighbors) {
      for (let units = 1; units < source.units; units += 1) {
        moves.push({ type: 'march', from: source.id, to: target, units });
      }
    }
  }

  return moves;
}

function snapshot(game) {
  return {
    round: game.round,
    turnNumber: game.turnNumber,
    currentSeat: game.currentSeat,
    status: game.status,
    players: game.players.map(({ id, name, seat, score, energy, color }) => ({
      id, name, seat, score, energy, color,
    })),
    nodes: game.board.nodes.map(({ id, owner, units, shield }) => ({ id, owner, units, shield })),
    winner: game.winner,
  };
}

function sameMove(candidate, action) {
  return Object.entries(candidate).every(([key, value]) => action[key] === value);
}

function territoryValue(game, playerId) {
  return game.board.nodes
    .filter(node => node.owner === playerId)
    .reduce((sum, node) => sum + node.value, 0);
}

function resolveWinner(game) {
  const ranked = game.players.map(player => ({
    player,
    score: player.score,
    core: game.board.nodes.find(node => node.id === game.board.coreId).owner === player.id ? 1 : 0,
    territory: territoryValue(game, player.id),
    units: game.board.nodes
      .filter(node => node.owner === player.id)
      .reduce((sum, node) => sum + node.units + node.shield, 0),
  })).sort((a, b) =>
    b.score - a.score
    || b.core - a.core
    || b.territory - a.territory
    || b.units - a.units
    || a.player.seat - b.player.seat);

  const top = ranked[0];
  const tiedOnScore = ranked[1] && ranked[1].score === top.score;
  game.winner = {
    playerId: top.player.id,
    name: top.player.name,
    score: top.score,
    reason: tiedOnScore ? 'Tiebreak: Core, territory, units, then seat' : 'Highest score',
  };
  game.status = 'finished';
}

function scoreRound(game, now) {
  const awards = game.players.map(player => {
    const points = territoryValue(game, player.id);
    player.score += points;
    return { playerId: player.id, name: player.name, points, total: player.score };
  });
  game.log.push({
    seq: `${game.turnNumber}-score`,
    kind: 'score',
    at: new Date(now).toISOString(),
    round: game.round,
    awards,
    text: awards.map(award => `${award.name} +${award.points}`).join(' · '),
  });

  if (game.round >= game.maxRounds || game.players.some(player => player.score >= game.targetScore)) {
    resolveWinner(game);
  }
}

export function applyMove(game, playerId, action, now = Date.now(), source = 'player') {
  const legal = getLegalMoves(game, playerId);
  const move = legal.find(candidate => sameMove(candidate, action));
  if (!move) throw new Error('Illegal move');

  const next = structuredClone(game);
  const player = next.players[next.currentSeat];
  let text = '';

  if (move.type === 'focus') {
    const gained = Math.min(3, MAX_ENERGY - player.energy);
    player.energy += gained;
    text = `${player.name} focused and gained ${gained} energy.`;
  } else if (move.type === 'deploy') {
    const node = next.board.nodes.find(candidate => candidate.id === move.node);
    player.energy -= move.units;
    node.units += move.units;
    text = `${player.name} deployed ${move.units} to ${node.label}.`;
  } else if (move.type === 'fortify') {
    const node = next.board.nodes.find(candidate => candidate.id === move.node);
    player.energy -= 2;
    node.shield = Math.min(4, node.shield + 2);
    text = `${player.name} fortified ${node.label} to ${node.shield} shield.`;
  } else if (move.type === 'march') {
    const from = next.board.nodes.find(node => node.id === move.from);
    const to = next.board.nodes.find(node => node.id === move.to);
    from.units -= move.units;
    if (to.owner === player.id) {
      to.units += move.units;
      text = `${player.name} shifted ${move.units} from ${from.label} to ${to.label}.`;
    } else {
      const defender = to.owner;
      const defense = to.units + to.shield;
      if (move.units > defense) {
        to.owner = player.id;
        to.units = move.units - defense;
        to.shield = 0;
        text = `${player.name} captured ${to.label} with ${move.units} units.`;
      } else if (move.units === defense) {
        to.owner = null;
        to.units = 1;
        to.shield = 0;
        text = `${player.name} neutralized ${to.label} in a deadlock.`;
      } else {
        const shieldDamage = Math.min(to.shield, move.units);
        to.shield -= shieldDamage;
        to.units -= move.units - shieldDamage;
        text = `${player.name} attacked ${to.label}; ${defender ? 'the defense held' : 'the relay resisted'}.`;
      }
    }
  }

  next.turnNumber += 1;
  const event = {
    seq: next.turnNumber,
    kind: 'move',
    at: new Date(now).toISOString(),
    round: next.round,
    seat: player.seat,
    playerId: player.id,
    source,
    action: move,
    text,
  };
  next.log.push(event);

  next.turnIndex += 1;
  if (next.turnIndex >= next.players.length) {
    scoreRound(next, now);
    if (next.status === 'active') {
      next.round += 1;
      next.turnIndex = 0;
      next.currentSeat = (next.round - 1) % next.players.length;
    }
  } else {
    next.currentSeat = (next.round - 1 + next.turnIndex) % next.players.length;
  }
  next.turnStartedAt = now;
  next.turnDeadline = next.status === 'active' ? now + TURN_MS : null;
  next.replay.push({ ...event, snapshot: snapshot(next) });
  return next;
}

function stableHash(text) {
  let value = 2166136261;
  for (const char of text) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

export function chooseBotMove(game, playerId) {
  const moves = getLegalMoves(game, playerId);
  if (!moves.length) throw new Error('No legal move');
  const player = game.players.find(candidate => candidate.id === playerId);
  const node = id => game.board.nodes.find(candidate => candidate.id === id);
  const scored = moves.map(move => {
    let score = 0;
    if (move.type === 'march') {
      const target = node(move.to);
      const source = node(move.from);
      if (target.owner === playerId) score = 7 + (source.units > 5 ? 3 : 0);
      else {
        const margin = move.units - target.units - target.shield;
        score = margin > 0 ? 45 + target.value * 18 - margin : 5 + move.units;
      }
    } else if (move.type === 'deploy') {
      const target = node(move.node);
      score = 18 + target.value * 3 + move.units - target.units;
    } else if (move.type === 'fortify') {
      const target = node(move.node);
      score = 17 + target.value * 4 - target.shield;
    } else if (move.type === 'focus') {
      score = player.energy <= 2 ? 35 : 10;
    }
    return { move, score, tie: stableHash(`${game.turnNumber}:${playerId}:${JSON.stringify(move)}`) };
  });
  scored.sort((a, b) => b.score - a.score || a.tie - b.tie);
  return scored[0].move;
}

export function applyTimeout(game, now = Date.now()) {
  let next = game;
  if (next.status !== 'active' || now < next.turnDeadline) return next;
  const startingRound = next.round;
  const timedOut = next.players[next.currentSeat];
  next = applyMove(next, timedOut.id, chooseBotMove(next, timedOut.id), now, 'autopilot');
  while (next.status === 'active' && next.round === startingRound && next.players[next.currentSeat].isBot) {
    const bot = next.players[next.currentSeat];
    next = applyMove(next, bot.id, chooseBotMove(next, bot.id), now, 'bot');
  }
  return next;
}
