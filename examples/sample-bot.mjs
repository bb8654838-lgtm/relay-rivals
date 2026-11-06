#!/usr/bin/env node

const [baseArg, codeArg, nameArg = 'Circuit Sample'] = process.argv.slice(2);

if (!baseArg || !codeArg) {
  console.error('Usage: node examples/sample-bot.mjs <base-url> <room-code> [name]');
  process.exit(2);
}

const baseUrl = baseArg.replace(/\/$/, '');
const roomCode = codeArg.trim().toUpperCase();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${method} ${path} failed (${response.status})`);
  return payload;
}

function chooseMove(moves) {
  const marches = moves
    .filter((move) => move.type === 'march')
    .sort((a, b) => b.units - a.units);
  const deploys = moves
    .filter((move) => move.type === 'deploy')
    .sort((a, b) => b.units - a.units);
  return marches[0]
    || deploys[0]
    || moves.find((move) => move.type === 'fortify')
    || moves.find((move) => move.type === 'focus')
    || moves[0];
}

const joined = await request(`/api/lobbies/${roomCode}/join`, {
  method: 'POST',
  body: { name: nameArg },
});
const token = joined.token;
const playerId = joined.state.me.id;
console.log(`Joined ${roomCode} as ${nameArg} (${playerId}).`);

while (true) {
  const { state } = await request(`/api/lobbies/${roomCode}/state`, { token });
  if (state.status === 'finished') {
    const winner = state.game?.winner?.name || state.game?.winner?.playerId || 'unknown';
    console.log(`Match finished. Winner: ${winner}.`);
    break;
  }
  if (state.status === 'waiting') {
    await sleep(750);
    continue;
  }
  if (state.currentPlayerId !== playerId) {
    await sleep(500);
    continue;
  }

  const move = chooseMove(state.legalMoves || []);
  if (!move) throw new Error('No legal move was returned for this turn.');
  console.log(`Round ${state.game.round}: ${JSON.stringify(move)}`);
  await request(`/api/lobbies/${roomCode}/move`, {
    method: 'POST',
    token,
    body: { move },
  });
}
