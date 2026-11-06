# Relay Rivals

Relay Rivals is a deterministic, server-authoritative strategy game for 2–4 human or HTTP players. A match runs for six rounds on a 12-relay ring surrounding a valuable Core, with one meaningful action per turn and no login required.

## Rules

Each player begins on an evenly spaced home relay with four units and four energy. On a turn, **Focus** restores up to three energy, **Deploy** spends energy to add units, **Fortify** spends two energy to add two shield, or **March** moves units to reinforce or attack an adjacent relay. A successful attack must exceed the target's units plus shield; an exact tie neutralizes it. At the end of each round, ordinary relays score one point and the Core scores three. The first player to 15 points wins, otherwise the highest score after round six wins; ties break by Core control, territory value, remaining units plus shields, then seat order.

## What ships

- No-login rooms with shareable six-character match codes
- Human browser client plus a documented HTTP/JSON interface
- Empty-seat backfill and a runnable sample HTTP player
- Deterministic six-round rules with server-side move validation
- Turn deadlines, persistent Durable Object room state, match log, and replay
- Responsive keyboard-accessible interface for desktop and mobile
- Unit and integration coverage for rules, rooms, authorization, autonomous turns, and replay hygiene

## Run locally

```bash
npm install
npm test
npm run check
npm run dev
```

Open the URL printed by Wrangler, create a room, fill the open seats, and start the match.

## Deploy

```bash
npm run deploy
```

Cloudflare provisions the `GameRoom` Durable Object from `wrangler.jsonc`. No application secrets are required.

## HTTP API

All successful responses are JSON. Creating or joining a room returns a player bearer token; send it as `Authorization: Bearer <token>` on player-specific requests. Room codes are case-insensitive.

### Create a room

```http
POST /api/lobbies
Content-Type: application/json

{"name":"Sam","maxPlayers":2}
```

### Join a room

```http
POST /api/lobbies/:code/join
Content-Type: application/json

{"name":"Circuit Sample"}
```

### Host controls

```http
POST /api/lobbies/:code/fill-bots
Authorization: Bearer <host-token>

POST /api/lobbies/:code/start
Authorization: Bearer <host-token>
```

### Read state

```http
GET /api/lobbies/:code/state
Authorization: Bearer <player-token>
```

The response includes `state.currentPlayerId`, `state.legalMoves`, public board state, scores, deadlines, and the match log. Legal moves are complete JSON objects; clients should submit one unchanged.

### Submit a move

```http
POST /api/lobbies/:code/move
Authorization: Bearer <player-token>
Content-Type: application/json

{"move":{"type":"focus"}}
```

Other legal move shapes are:

```json
{"type":"deploy","node":"r0","units":3}
{"type":"fortify","node":"r0"}
{"type":"march","from":"r0","to":"r1","units":2}
```

### Read the replay

```http
GET /api/lobbies/:code/replay
```

Replay responses include ordered actions and snapshots but never player tokens.

## Sample HTTP player

Create a room in the browser and leave one seat open, then run:

```bash
node examples/sample-bot.mjs http://127.0.0.1:8787 ABC123 "Circuit Sample"
```

The sample joins the supplied room, polls state, chooses only from `legalMoves`, submits on its turn, and exits after the match finishes. It intentionally uses only built-in `fetch`, so no extra runtime package is needed.

## Architecture

The static client and API run in one Cloudflare Worker. Each room code maps to a `GameRoom` Durable Object, which serializes mutations and persists room state. Rules live in `src/engine.js`; the Worker adapter, authorization, persistence, and routing live in `src/worker.js`.
