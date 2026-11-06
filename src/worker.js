import {
  applyMove,
  applyTimeout,
  chooseBotMove,
  createGame,
  getLegalMoves,
} from './engine.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const BOT_DELAY_MS = 20_000;
const PLAYER_COLORS = ['#79f7ff', '#ff5bd7', '#ffe17a', '#91ff8a'];

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, 'cache-control': 'no-store', ...extra },
  });
}

function randomToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function cleanName(value, fallback = 'Player') {
  const name = String(value || '').trim().replace(/[<>]/g, '').slice(0, 24);
  return name || fallback;
}

function clampSeats(value) {
  return Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Number(value) || MIN_PLAYERS));
}

function readToken(request, url) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || url.searchParams.get('token') || '';
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export class RoomCore {
  constructor({ storage = null, now = () => Date.now(), schedule = setTimeout, initialRoom = null } = {}) {
    this.storage = storage;
    this.now = now;
    this.schedule = schedule;
    this.room = initialRoom;
  }

  async persist() {
    if (!this.room) return;
    this.room.updatedAt = this.now();
    if (this.storage?.put) await this.storage.put('room', this.room);
  }

  publicLobby(token = '') {
    if (!this.room) return null;
    const viewer = this.room.players.find((player) => player.playerToken === token);
    return {
      code: this.room.code,
      seats: this.room.seats,
      maxPlayers: this.room.seats,
      status: this.room.game?.status || 'waiting',
      hostId: this.room.hostId,
      players: this.room.players.map(({ playerToken: _secret, ...player }) => player),
      me: viewer ? { id: viewer.id, name: viewer.name, isHost: viewer.id === this.room.hostId } : null,
      createdAt: this.room.createdAt,
      updatedAt: this.room.updatedAt,
    };
  }

  publicState(token = '') {
    if (!this.room?.game) {
      const lobby = this.publicLobby(token);
      return { ...lobby, game: null, legalMoves: [] };
    }

    const game = structuredClone(this.room.game);
    const current = game.players[game.currentSeat];
    const viewer = this.room.players.find((player) => player.playerToken === token);
    const legalMoves = current ? getLegalMoves(game, current.id) : [];
    const gameView = {
      ...game,
      currentPlayerId: current?.id || null,
      history: game.log,
      winnerId: game.winner?.playerId || null,
    };
    return {
      ...game,
      code: this.room.code,
      maxPlayers: this.room.seats,
      hostId: this.room.hostId,
      me: viewer ? { id: viewer.id, name: viewer.name, isHost: viewer.id === this.room.hostId } : null,
      turnDeadlineAt: game.turnDeadline,
      currentPlayerId: current?.id || null,
      legalMoves,
      game: gameView,
    };
  }

  isHostToken(token) {
    const host = this.room?.players.find((player) => player.id === this.room.hostId);
    return Boolean(token && (token === this.room.hostToken || token === host?.playerToken));
  }

  playerForToken(token) {
    return this.room?.players.find((player) => !player.isBot && player.playerToken === token) || null;
  }

  async create(body) {
    if (this.room) return json({ error: 'This room already exists.' }, 409);
    const playerToken = randomToken();
    const hostToken = randomToken();
    const player = {
      id: 'p1',
      name: cleanName(body.name, 'Host'),
      color: PLAYER_COLORS[0],
      isBot: false,
      playerToken,
    };
    this.room = {
      code: String(body.code || 'ROOM').toUpperCase(),
      seats: clampSeats(body.seats ?? body.maxPlayers),
      hostId: player.id,
      hostToken,
      players: [player],
      game: null,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    await this.persist();
    this.schedule(() => this.autoFillBots().catch(() => {}), BOT_DELAY_MS);
    return json({
      lobby: this.publicLobby(playerToken),
      playerToken,
      hostToken,
      token: playerToken,
      state: this.publicState(playerToken),
    });
  }

  async join(body) {
    if (!this.room) return json({ error: 'Room not found.' }, 404);
    if (this.room.game) return json({ error: 'This match has already started.' }, 409);
    if (this.room.players.length >= this.room.seats) return json({ error: 'This room is full.' }, 409);
    const playerToken = randomToken();
    const player = {
      id: `p${this.room.players.length + 1}`,
      name: cleanName(body.name, `Player ${this.room.players.length + 1}`),
      color: PLAYER_COLORS[this.room.players.length],
      isBot: false,
      playerToken,
    };
    this.room.players.push(player);
    await this.persist();
    return json({
      lobby: this.publicLobby(playerToken),
      playerToken,
      token: playerToken,
      state: this.publicState(playerToken),
    });
  }

  async autoFillBots() {
    if (!this.room || this.room.game) return;
    while (this.room.players.length < this.room.seats) {
      const number = this.room.players.length + 1;
      this.room.players.push({
        id: `p${number}`,
        name: `Pulse Bot ${number - 1}`,
        color: PLAYER_COLORS[number - 1],
        isBot: true,
        playerToken: null,
      });
    }
    await this.persist();
  }

  async fillBots(request, url) {
    if (!this.room) return json({ error: 'Room not found.' }, 404);
    const token = readToken(request, url);
    if (!this.isHostToken(token)) return json({ error: 'Only the host can fill seats.' }, 403);
    await this.autoFillBots();
    return json({ lobby: this.publicLobby(token), state: this.publicState(token) });
  }

  async start(request, url) {
    if (!this.room) return json({ error: 'Room not found.' }, 404);
    if (this.room.game) return json({ error: 'This match has already started.' }, 409);
    const token = readToken(request, url);
    if (!this.isHostToken(token)) return json({ error: 'Only the host can start.' }, 403);
    if (this.room.players.length < MIN_PLAYERS) await this.autoFillBots();
    this.room.game = createGame(
      this.room.players.map(({ playerToken: _secret, ...player }) => player),
      this.now(),
    );
    await this.runBots();
    await this.persist();
    const state = this.publicState(token);
    return json({ state, legalMoves: state.legalMoves });
  }

  async runBots() {
    let guard = 0;
    while (this.room?.game?.status === 'active' && guard < 32) {
      const game = this.room.game;
      const current = game.players[game.currentSeat];
      if (!current?.isBot) break;
      this.room.game = applyMove(game, current.id, chooseBotMove(game, current.id), this.now(), 'bot');
      guard += 1;
    }
  }

  async advanceTimeout() {
    if (!this.room?.game || this.room.game.status !== 'active') return;
    const before = this.room.game.turnNumber;
    this.room.game = applyTimeout(this.room.game, this.now());
    if (this.room.game.turnNumber !== before) {
      await this.runBots();
      await this.persist();
    }
  }

  async move(request, url) {
    if (!this.room?.game || this.room.game.status !== 'active') return json({ error: 'No active match.' }, 409);
    const token = readToken(request, url);
    const player = this.playerForToken(token);
    if (!player) return json({ error: 'A valid player token is required.' }, 401);
    const body = await readJson(request);
    try {
      this.room.game = applyMove(this.room.game, player.id, body.action || body.move || body, this.now());
      await this.runBots();
      await this.persist();
      const state = this.publicState(token);
      return json({ state, legalMoves: state.legalMoves });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Illegal move.' }, 400);
    }
  }

  replay() {
    if (!this.room?.game) return json({ error: 'No replay is available yet.' }, 404);
    return json({
      code: this.room.code,
      events: this.room.game.replay,
      log: this.room.game.log,
      winner: this.room.game.winner,
      finalState: this.publicState(),
    });
  }

  async handle(request) {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\/+|\/+$/g, '') || 'state';
    await this.advanceTimeout();
    if (request.method === 'POST' && action === 'create') return this.create(await readJson(request));
    if (request.method === 'POST' && action === 'join') return this.join(await readJson(request));
    if (request.method === 'POST' && action === 'fill-bots') return this.fillBots(request, url);
    if (request.method === 'POST' && action === 'start') return this.start(request, url);
    if (request.method === 'POST' && action === 'move') return this.move(request, url);
    if (request.method === 'GET' && action === 'state') {
      if (!this.room) return json({ error: 'Room not found.' }, 404);
      const state = this.publicState(readToken(request, url));
      return json({ state, legalMoves: state.legalMoves });
    }
    if (request.method === 'GET' && action === 'replay') return this.replay();
    return json({ error: 'Route not found.' }, 404);
  }
}

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    const initialize = async () => {
      const initialRoom = (await this.ctx.storage.get('room')) || null;
      this.core = new RoomCore({
        storage: this.ctx.storage,
        initialRoom,
        schedule: (_callback, delay) => this.ctx.storage.setAlarm(Date.now() + delay),
      });
    };
    this.ready = this.ctx.blockConcurrencyWhile ? this.ctx.blockConcurrencyWhile(initialize) : initialize();
  }

  async fetch(request) {
    await this.ready;
    return this.core.handle(request);
  }

  async alarm() {
    await this.ready;
    await this.core.autoFillBots();
  }
}

function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('');
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') return json({ ok: true, game: 'Relay Rivals', version: 1 });

    if (url.pathname === '/api/lobbies' && request.method === 'POST') {
      const code = roomCode();
      const id = env.GAME_ROOM.idFromName(code);
      const stub = env.GAME_ROOM.get(id);
      const body = await readJson(request);
      return stub.fetch(new Request(`${url.origin}/create`, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify({ ...body, code }),
      }));
    }

    const match = url.pathname.match(/^\/api\/lobbies\/([A-Z0-9]{4,8})\/(join|fill-bots|start|state|move|replay)$/i);
    if (match) {
      const code = match[1].toUpperCase();
      const action = match[2].toLowerCase();
      const id = env.GAME_ROOM.idFromName(code);
      const stub = env.GAME_ROOM.get(id);
      const forward = new URL(`https://room.internal/${action}`);
      forward.search = url.search;
      return stub.fetch(new Request(forward, request));
    }

    if (url.pathname.startsWith('/api/')) return json({ error: 'API route not found.' }, 404);
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
