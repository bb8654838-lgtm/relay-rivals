import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMove, createGame, getLegalMoves } from '../src/engine.js';

const players = count => Array.from({ length: count }, (_, seat) => ({
  id: `p${seat + 1}`,
  name: `Player ${seat + 1}`,
  seat,
  isBot: false,
}));

test('createGame gives 2-4 players symmetric homes on a 12-node ring', () => {
  const expectedHomes = {
    2: ['r0', 'r6'],
    3: ['r0', 'r4', 'r8'],
    4: ['r0', 'r3', 'r6', 'r9'],
  };

  for (const count of [2, 3, 4]) {
    const game = createGame(players(count), 1_000);
    assert.equal(game.status, 'active');
    assert.equal(game.round, 1);
    assert.equal(game.currentSeat, 0);
    assert.equal(game.board.nodes.length, 13);
    assert.deepEqual(game.players.map(player => player.homeNode), expectedHomes[count]);
    assert.deepEqual(
      expectedHomes[count].map(id => game.board.nodes.find(node => node.id === id).units),
      Array(count).fill(4),
    );
  }
});

test('getLegalMoves exposes tempo, growth, defense, and movement choices', () => {
  const game = createGame(players(2), 1_000);
  const moves = getLegalMoves(game, 'p1');
  const types = new Set(moves.map(move => move.type));

  assert.deepEqual(types, new Set(['focus', 'deploy', 'fortify', 'march']));
  assert.ok(moves.some(move => move.type === 'march' && move.from === 'r0' && move.to === 'core'));
  assert.deepEqual(getLegalMoves(game, 'p2'), []);
});

test('deploy spends energy, adds units, records the move, and advances the turn', () => {
  const game = createGame(players(2), 1_000);
  const next = applyMove(game, 'p1', { type: 'deploy', node: 'r0', units: 3 }, 2_000);

  assert.equal(game.board.nodes.find(node => node.id === 'r0').units, 4, 'input remains immutable');
  assert.equal(next.board.nodes.find(node => node.id === 'r0').units, 7);
  assert.equal(next.players[0].energy, 1);
  assert.equal(next.currentSeat, 1);
  assert.equal(next.turnDeadline, 22_000);
  assert.match(next.log.at(-1).text, /deployed 3/i);
  assert.equal(next.replay.length, 1);
});

test('march resolves shields, captures nodes, and rejects illegal moves without mutation', () => {
  const game = createGame(players(2), 1_000);
  assert.throws(() => applyMove(game, 'p2', { type: 'focus' }, 2_000), /illegal/i);

  const core = game.board.nodes.find(node => node.id === 'core');
  core.units = 1;
  core.shield = 1;
  const next = applyMove(game, 'p1', { type: 'march', from: 'r0', to: 'core', units: 3 }, 2_000);
  const captured = next.board.nodes.find(node => node.id === 'core');
  assert.equal(captured.owner, 'p1');
  assert.equal(captured.units, 1);
  assert.equal(captured.shield, 0);
  assert.equal(next.board.nodes.find(node => node.id === 'r0').units, 1);
});

test('focus and fortify trade tempo for energy and defense', () => {
  let game = createGame(players(2), 1_000);
  game = applyMove(game, 'p1', { type: 'fortify', node: 'r0' }, 2_000);
  assert.equal(game.players[0].energy, 2);
  assert.equal(game.board.nodes.find(node => node.id === 'r0').shield, 2);
  game = applyMove(game, 'p2', { type: 'focus' }, 3_000);
  assert.equal(game.players[1].energy, 7);
});

test('a completed round scores territory and rotates first player', () => {
  let game = createGame(players(2), 1_000);
  game = applyMove(game, 'p1', { type: 'focus' }, 2_000);
  game = applyMove(game, 'p2', { type: 'focus' }, 3_000);

  assert.equal(game.round, 2);
  assert.equal(game.turnIndex, 0);
  assert.equal(game.currentSeat, 1);
  assert.deepEqual(game.players.map(player => player.score), [1, 1]);
  assert.ok(game.log.some(event => event.kind === 'score'));
});

test('six rounds always produce one deterministic winner', () => {
  let game = createGame(players(2), 1_000);
  let now = 2_000;
  while (game.status === 'active') {
    const player = game.players[game.currentSeat];
    const move = getLegalMoves(game, player.id).find(candidate => candidate.type === 'focus')
      ?? getLegalMoves(game, player.id)[0];
    game = applyMove(game, player.id, move, now);
    now += 1_000;
  }

  assert.equal(game.round, 6);
  assert.equal(game.status, 'finished');
  assert.equal(game.winner.playerId, 'p1');
  assert.match(game.winner.reason, /score|tiebreak/i);
});

test('bot and timeout helpers always choose legal actions', async () => {
  const { applyTimeout, chooseBotMove } = await import('../src/engine.js');
  const specs = players(2);
  specs[1].isBot = true;
  let game = createGame(specs, 1_000);
  const choice = chooseBotMove(game, 'p1');
  assert.ok(getLegalMoves(game, 'p1').some(move => JSON.stringify(move) === JSON.stringify(choice)));

  game.turnDeadline = 1_500;
  game = applyTimeout(game, 2_000);
  assert.equal(game.turnNumber, 2, 'timed-out human and following bot both play');
  assert.equal(game.log[0].source, 'autopilot');
  assert.equal(game.log[1].source, 'bot');
});
