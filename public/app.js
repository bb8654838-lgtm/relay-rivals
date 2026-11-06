const $ = (selector) => document.querySelector(selector);
const screens = ['landing', 'lobby', 'game', 'finish'];
const colors = ['#79f7ff', '#ff5bd7', '#ffe17a', '#91ff8a'];
let mode = 'create';
let roomCode = '';
let token = '';
let state = null;
let pollTimer = null;
let clockTimer = null;
let pending = false;

function showScreen(name) {
  screens.forEach((id) => $(`#${id}`).classList.toggle('hidden', id !== name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

async function api(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function saveSession() {
  if (!roomCode || !token) return;
  sessionStorage.setItem(`relay:${roomCode}`, token);
  const url = new URL(location.href);
  url.searchParams.set('room', roomCode);
  history.replaceState(null, '', url);
}

function openSetup(nextMode, presetCode = '') {
  mode = nextMode;
  $('#setupEyebrow').textContent = mode === 'create' ? 'CREATE A MATCH' : 'JOIN A MATCH';
  $('#setupTitle').textContent = mode === 'create' ? 'Enter the circuit' : 'Pick your callsign';
  $('#codeField').classList.toggle('hidden', mode === 'create');
  $('#sizeField').classList.toggle('hidden', mode !== 'create');
  $('#setupSubmit').textContent = mode === 'create' ? 'Create lobby' : 'Join lobby';
  $('#codeInput').value = presetCode;
  $('#setupError').textContent = '';
  $('#setupDialog').showModal();
  setTimeout(() => $('#nameInput').focus(), 60);
}

async function submitSetup(event) {
  event.preventDefault();
  if (pending) return;
  const name = $('#nameInput').value.trim();
  if (!name) return ($('#setupError').textContent = 'Choose a display name.');
  pending = true;
  $('#setupSubmit').disabled = true;
  try {
    let result;
    if (mode === 'create') {
      result = await api('/api/lobbies', {
        method: 'POST',
        body: JSON.stringify({ name, maxPlayers: Number($('#sizeInput').value) }),
      });
      roomCode = result.state.code;
    } else {
      roomCode = $('#codeInput').value.trim().toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(roomCode)) throw new Error('Enter a valid room code.');
      result = await api(`/api/lobbies/${roomCode}/join`, { method: 'POST', body: JSON.stringify({ name }) });
    }
    token = result.token;
    state = result.state;
    saveSession();
    $('#setupDialog').close();
    render();
    startPolling();
  } catch (error) {
    $('#setupError').textContent = error.message;
  } finally {
    pending = false;
    $('#setupSubmit').disabled = false;
  }
}

async function loadState(silent = false) {
  if (!roomCode) return;
  try {
    const result = await api(`/api/lobbies/${roomCode}/state?token=${encodeURIComponent(token)}`);
    state = result.state;
    render();
  } catch (error) {
    if (!silent) $('#gameError').textContent = error.message;
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => loadState(true), 1200);
}

function render() {
  if (!state) return;
  if (state.status === 'waiting') renderLobby();
  else if (state.status === 'finished') renderFinish();
  else renderGame();
}

function renderLobby() {
  showScreen('lobby');
  $('#copyCode').textContent = state.code;
  const meIsHost = state.me?.isHost;
  $('#startBtn').classList.toggle('hidden', !meIsHost);
  $('#botsBtn').classList.toggle('hidden', !meIsHost);
  $('#playerList').innerHTML = Array.from({ length: state.maxPlayers }, (_, index) => {
    const player = state.players[index];
    if (!player) return `<div class="player-card"><span class="player-swatch" style="color:#303952;background:#303952"></span><span>Open slot</span><small>WAITING</small></div>`;
    return `<div class="player-card"><span class="player-swatch" style="color:${player.color};background:${player.color}"></span><span>${escapeHtml(player.name)}</span><small>${player.isBot ? 'AI' : player.id === state.hostId ? 'HOST' : 'READY'}</small></div>`;
  }).join('');
}

function renderGame() {
  showScreen('game');
  const game = state.game;
  const current = state.players.find((player) => player.id === game.currentPlayerId);
  const myTurn = state.me?.id === game.currentPlayerId;
  $('#gameCode').textContent = state.code;
  $('#turnTitle').textContent = myTurn ? 'Your move' : `${current?.name || 'Player'} is choosing…`;
  $('#roundLabel').textContent = `ROUND ${game.round} / ${game.maxRounds}`;
  $('#coreRound').textContent = game.round;
  $('#commandTitle').textContent = myTurn ? 'Choose one action' : 'Watching the circuit';
  $('#commandHint').textContent = myTurn ? `${game.players.find((p) => p.id === state.me.id)?.energy ?? 0} energy available` : 'The board updates automatically.';
  renderScores(game);
  renderBoard(game);
  renderMoves(state.legalMoves || []);
  renderHistory(game.history || []);
  runClock();
}

function renderScores(game) {
  const territory = game.board.nodes.reduce((out, node) => {
    if (node.owner) out[node.owner] = (out[node.owner] || 0) + 1;
    return out;
  }, {});
  $('#scoreboard').innerHTML = game.players.map((player) => `<div class="score-chip ${player.id === game.currentPlayerId ? 'active' : ''}" style="--color:${player.color}"><i></i><span>${escapeHtml(player.name)} · ${territory[player.id] || 0} nodes</span><b>${player.score}</b></div>`).join('');
}

function renderBoard(game) {
  const svg = $('#board');
  const center = 360;
  const radius = 278;
  const ring = game.board.nodes.filter((node) => node.kind === 'relay');
  const positions = ring.map((node, index) => {
    const angle = (index / ring.length) * Math.PI * 2 - Math.PI / 2;
    return { id: node.id, x: center + Math.cos(angle) * radius, y: center + Math.sin(angle) * radius };
  });
  const coreId = game.board.coreId || 'core';
  positions.push({ id: coreId, x: center, y: center });
  const pos = Object.fromEntries(positions.map((item) => [item.id, item]));
  const seenEdges = new Set();
  const edgePairs = [];
  game.board.nodes.forEach((node) => (node.neighbors || []).forEach((neighbor) => {
    if (!pos[node.id] || !pos[neighbor]) return;
    const key = [node.id, neighbor].sort().join('|');
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edgePairs.push([node.id, neighbor]);
  }));
  const edges = edgePairs.map(([from, to]) => `<line class="edge" x1="${pos[from].x}" y1="${pos[from].y}" x2="${pos[to].x}" y2="${pos[to].y}"/>`).join('');
  const nodes = positions.map(({ id, x, y }) => {
    const node = game.board.nodes.find((candidate) => candidate.id === id);
    const owner = game.players.find((player) => player.id === node.owner);
    const color = owner?.color || '#4c5876';
    return `<g class="node" data-node="${id}" tabindex="0" role="button" aria-label="Node ${id}, ${node.units} units${node.shield ? ', shielded' : ''}" style="--node-color:${color}" transform="translate(${x} ${y})">
      <circle class="base" r="38"/><circle class="owner" r="31"/>${node.shield ? '<circle class="shield" r="45"/>' : ''}
      <text y="7">${node.units}</text><text class="node-id" y="24">${id}</text>
    </g>`;
  }).join('');
  svg.innerHTML = `<circle cx="360" cy="360" r="279" fill="none" stroke="#161d33" stroke-width="42"/>${edges}${nodes}`;
  svg.querySelectorAll('.node').forEach((node) => {
    const activate = () => playBestNodeMove(node.dataset.node);
    node.addEventListener('click', activate);
    node.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') activate(); });
  });
}

function labelMove(move) {
  if (move.type === 'focus') return ['FOCUS', 'Gain up to 3 energy for a later strike'];
  if (move.type === 'deploy') return [`DEPLOY · ${move.node} · +${move.units}`, `Spend ${move.units} energy, add ${move.units} unit${move.units === 1 ? '' : 's'}`];
  if (move.type === 'fortify') return [`FORTIFY · ${move.node}`, 'Spend 2 energy, add 2 shield'];
  return [`MARCH · ${move.from} → ${move.to}`, `Move ${move.units} unit${move.units === 1 ? '' : 's'}`];
}

function renderMoves(moves) {
  const list = $('#legalMoves');
  if (!moves.length) {
    list.innerHTML = '<p class="muted">No commands available while another player acts.</p>';
    return;
  }
  const useful = moves.filter((move) => move.type !== 'march' || move.units === Math.max(...moves.filter((m) => m.type === 'march' && m.from === move.from && m.to === move.to).map((m) => m.units)));
  list.innerHTML = useful.slice(0, 18).map((move, index) => { const [title, detail] = labelMove(move); return `<button class="move-btn" data-index="${index}"><b>${title}</b><small>${detail}</small></button>`; }).join('');
  list.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => sendMove(useful[Number(button.dataset.index)])));
}

function playBestNodeMove(nodeId) {
  const moves = state?.legalMoves || [];
  const move = moves.find((candidate) => candidate.type === 'deploy' && candidate.node === nodeId)
    || moves.find((candidate) => candidate.type === 'fortify' && candidate.node === nodeId)
    || moves.filter((candidate) => candidate.type === 'march' && candidate.from === nodeId).sort((a, b) => b.units - a.units)[0];
  if (move) sendMove(move);
  else toast('No legal command for that node');
}

async function sendMove(move) {
  if (pending || !move) return;
  pending = true;
  $('#gameError').textContent = '';
  try {
    const result = await api(`/api/lobbies/${roomCode}/move`, { method: 'POST', body: JSON.stringify({ move }) });
    state = result.state;
    render();
  } catch (error) {
    $('#gameError').textContent = error.message;
  } finally { pending = false; }
}

function renderHistory(history) {
  const players = Object.fromEntries((state.players || []).map((player) => [player.id, player.name]));
  $('#history').innerHTML = history.slice(-9).reverse().map((entry) => {
    if (entry.kind === 'score') {
      return `<li>R${entry.round} · SCORE · ${escapeHtml(entry.text || 'Round scored')}</li>`;
    }
    const move = entry.action;
    if (!move) return `<li>R${entry.round} · ${escapeHtml(entry.text || entry.kind || 'Event')}</li>`;
    const detail = move.type === 'march' ? `${move.from} → ${move.to} (${move.units})` : move.node || '';
    return `<li>R${entry.round} · ${escapeHtml(players[entry.playerId] || entry.playerId)} ${escapeHtml(move.type.toUpperCase())} ${escapeHtml(detail)}</li>`;
  }).join('') || '<li>The circuit is quiet.</li>';
}

function runClock() {
  clearInterval(clockTimer);
  const tick = () => {
    if (!state?.turnDeadlineAt) return;
    const remaining = Math.max(0, state.turnDeadlineAt - Date.now());
    $('#timerBar').style.width = `${Math.min(100, remaining / 450)}%`;
  };
  tick();
  clockTimer = setInterval(tick, 200);
}

function renderFinish() {
  showScreen('finish');
  clearInterval(clockTimer);
  const game = state.game;
  const winner = game.players.find((player) => player.id === game.winner?.playerId);
  $('#winnerTitle').textContent = `${winner?.name || 'A rival'} wins the relay`;
  $('#winnerSummary').textContent = `Six rounds complete. ${game.history.length} decisions are locked into the replay.`;
  $('#finalScores').innerHTML = [...game.players].sort((a, b) => b.score - a.score).map((player, index) => `<div class="finish-score"><span>${index + 1}. ${escapeHtml(player.name)}</span><b>${player.score} pts</b></div>`).join('');
}

async function copyInvite() {
  const link = `${location.origin}${location.pathname}?room=${state.code}`;
  await navigator.clipboard.writeText(link).catch(() => {});
  toast('Invite link copied');
}

async function fillBots() {
  try { const result = await api(`/api/lobbies/${roomCode}/fill-bots`, { method: 'POST', body: '{}' }); state = result.state; render(); }
  catch (error) { $('#lobbyError').textContent = error.message; }
}

async function startMatch() {
  try { const result = await api(`/api/lobbies/${roomCode}/start`, { method: 'POST', body: '{}' }); state = result.state; render(); }
  catch (error) { $('#lobbyError').textContent = error.message; }
}

async function showReplay() {
  try { const replay = await api(`/api/lobbies/${roomCode}/replay`); $('#replayData').textContent = JSON.stringify(replay, null, 2); $('#replayData').classList.remove('hidden'); }
  catch (error) { toast(error.message); }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function home() { clearInterval(pollTimer); clearInterval(clockTimer); state = null; roomCode = ''; token = ''; history.replaceState(null, '', location.pathname); showScreen('landing'); }

document.querySelectorAll('[data-home]').forEach((button) => button.addEventListener('click', home));
document.querySelectorAll('[data-rules]').forEach((button) => button.addEventListener('click', () => $('#rulesDialog').showModal()));
document.querySelectorAll('[data-close-rules]').forEach((button) => button.addEventListener('click', () => $('#rulesDialog').close()));
$('#createBtn').addEventListener('click', () => openSetup('create'));
$('#joinBtn').addEventListener('click', () => openSetup('join'));
$('#setupForm').addEventListener('submit', submitSetup);
$('#copyCode').addEventListener('click', async () => { await navigator.clipboard.writeText(state.code).catch(() => {}); toast('Room code copied'); });
$('#shareBtn').addEventListener('click', copyInvite);
$('#botsBtn').addEventListener('click', fillBots);
$('#startBtn').addEventListener('click', startMatch);
$('#rematchBtn').addEventListener('click', home);
$('#replayBtn').addEventListener('click', showReplay);

const preset = new URL(location.href).searchParams.get('room')?.toUpperCase();
if (preset && /^[A-Z0-9]{4,8}$/.test(preset)) {
  const saved = sessionStorage.getItem(`relay:${preset}`);
  if (saved) { roomCode = preset; token = saved; loadState().then(startPolling); }
  else openSetup('join', preset);
}
