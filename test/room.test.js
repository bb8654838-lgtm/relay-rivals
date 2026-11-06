import test from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom } from '../src/worker.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
}

function request(path, method = 'GET', body, token) {
  return new Request(`https://game.test${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function json(response, status = 200) {
  assert.equal(response.status, status);
  return response.json();
}

test('room lifecycle supports lobby codes, bots, authenticated moves, state, and replay', async () => {
  const state = { storage: new MemoryStorage() };
  const room = new GameRoom(state, {});

  const created = await json(await room.fetch(request('/create', 'POST', {
    code: 'ABC123', name: 'Nova', seats: 3,
  })));
  assert.equal(created.lobby.code, 'ABC123');
  assert.equal(created.lobby.players.length, 1);
  assert.ok(created.playerToken);
  assert.ok(created.hostToken);

  const joined = await json(await room.fetch(request('/join', 'POST', { name: 'Orion' })));
  assert.equal(joined.lobby.players.length, 2);

  const filled = await json(await room.fetch(request('/fill-bots', 'POST', {}, created.hostToken)));
  assert.equal(filled.lobby.players.length, 3);
  assert.equal(filled.lobby.players[2].isBot, true);

  const started = await json(await room.fetch(request('/start', 'POST', {}, created.hostToken)));
  assert.equal(started.state.status, 'active');
  assert.equal(started.state.players.length, 3);

  await json(await room.fetch(request('/move', 'POST', { action: { type: 'focus' } }, 'wrong')), 401);
  const moved = await json(await room.fetch(request('/move', 'POST', { action: { type: 'focus' } }, created.playerToken)));
  assert.equal(moved.state.turnNumber, 1);
  assert.equal(moved.state.currentSeat, 1);

  const stateView = await json(await room.fetch(request('/state')));
  assert.equal(stateView.state.players[1].name, 'Orion');
  assert.ok(stateView.legalMoves.length > 0);
  assert.equal('token' in stateView.state.players[0], false);

  const replay = await json(await room.fetch(request('/replay')));
  assert.equal(replay.events.length, 1);
});
