const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m',
  green: '\x1b[32m', cyan: '\x1b[36m',
  yellow: '\x1b[33m', red: '\x1b[31m',
  white: '\x1b[37m', bold: '\x1b[1m',
};
function ts() { return C.dim + new Date().toTimeString().slice(0, 8) + C.reset; }
function log(tag, col, m) { console.log(`${ts()} ${col}[${tag}]${C.reset} ${m}`); }
const L = {
  info: m => log('INFO ', C.cyan, m),
  ok: m => log('OK   ', C.green, m),
  warn: m => log('WARN ', C.yellow, m),
  err: m => log('ERR  ', C.red, m),
  room: m => log('ROOM ', C.white, m),
  game: m => log('GAME ', C.green, m),
  sock: m => log('SOCK ', C.dim, m),
};

// ── Global username registry ──────────────────────────────────────────────────
// Maps lowercase username → socket.id. Source of truth for uniqueness.
const userRegistry = new Map();

function isUsernameTaken(username) {
  const lc = username.toLowerCase();
  const existingSocketId = userRegistry.get(lc);
  if (!existingSocketId) return false;
  // Check if that socket is still actually connected
  return io.sockets.sockets.get(existingSocketId)?.connected === true;
}

function registerUser(username, socketId) {
  userRegistry.set(username.toLowerCase(), socketId);
}

function unregisterUser(username) {
  if (username) userRegistry.delete(username.toLowerCase());
}

// ── Room store ────────────────────────────────────────────────────────────────
const rooms = {};

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms[code]);
  return code;
}

function roomOf(socket) { return rooms[socket.data?.roomId]; }
function broadcast(rid, ev, data) { io.to(rid).emit(ev, data); }

function pushState(rid) {
  const r = rooms[rid];
  if (!r) return;
  broadcast(rid, 'room_state', {
    id: r.id, gameType: r.gameType, hostId: r.hostId,
    players: r.players, state: r.state,
  });
}

function pushRoomList() {
  const list = Object.values(rooms)
    .filter(r => r.players.length >= 1 && r.state === 'lobby')
    .map(r => ({
      id: r.id,
      gameType: r.gameType,
      playerCount: r.players.length,
      hostUsername: r.hostUsername,
    }));
  io.emit('room_list', list);
}

function pushPlayersList() {
  // Build list of all sockets that have claimed a username
  const players = [];
  for (const [id, sock] of io.sockets.sockets) {
    if (!sock.connected || !sock.data?.username) continue;
    const rid = sock.data?.roomId;
    const room = rid ? rooms[rid] : null;
    players.push({
      username: sock.data.username,
      roomId: rid || null,
      gameType: room ? room.gameType : null,
    });
  }
  // Sort: hub users first, then in-game, alphabetically within each group
  players.sort((a, b) => {
    if (!!a.roomId !== !!b.roomId) return a.roomId ? 1 : -1;
    return a.username.localeCompare(b.username);
  });
  io.emit('players_list', players);
}

// ── Deferred room cleanup ─────────────────────────────────────────────────────
function scheduleCleanup(rid) {
  const r = rooms[rid];
  if (!r) return;
  if (r.cleanupTimer) clearTimeout(r.cleanupTimer);

  r.cleanupTimer = setTimeout(() => {
    const rr = rooms[rid];
    if (!rr) return;
    let shouldDelete = rr.players.length === 0;
    if (rr.players.length === 1) {
      const p = rr.players[0];
      const stillConnected = io.sockets.sockets.get(p.id)?.connected === true;
      if (!stillConnected) shouldDelete = true;
    }
    if (shouldDelete) {
      if (rr.gameTimer) clearTimeout(rr.gameTimer);
      delete rooms[rr.id];
      L.room(`Cleaned   [${rid}] — empty/stale after grace period`);
      pushRoomList();
    } else {
      L.room(`Grace cancelled [${rid}] — active player(s) present`);
    }
  }, 15000);

  L.room(`Grace     [${rid}] — cleanup in 15s (last player or empty)`);
}

// ── Connection ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  L.sock(`Connect   ${socket.id.slice(0, 8)}`);

  // Send current state on connect
  // (players_list will be sent again after claim_username)
  socket.emit('room_list', Object.values(rooms)
    .filter(r => r.players.length >= 1 && r.state === 'lobby')
    .map(r => ({ id: r.id, gameType: r.gameType, playerCount: r.players.length, hostUsername: r.hostUsername })));

  // CLAIM USERNAME ─────────────────────────────────────────────────────────────
  // Called when user hits "access hub". Atomically claims the username.
  socket.on('claim_username', ({ username }) => {
    const lc = username.toLowerCase();
    if (isUsernameTaken(lc)) {
      socket.emit('username_claim_result', { ok: false, reason: `username "${lc}" is already taken on this network.` });
      return;
    }
    // Release any previous username this socket had (e.g. re-login)
    if (socket.data.username) unregisterUser(socket.data.username);
    registerUser(lc, socket.id);
    socket.data.username = lc;
    socket.emit('username_claim_result', { ok: true, username: lc });
    pushPlayersList();
    L.ok(`Claimed   username="${lc}" by ${socket.id.slice(0, 8)}`);
  });

  // CREATE ────────────────────────────────────────────────────────────────────
  socket.on('create_room', ({ username, gameType }) => {
    const lc = username.toLowerCase();
    const id = makeCode();
    rooms[id] = {
      id, gameType,
      hostId: socket.id,
      hostUsername: lc,
      players: [{ id: socket.id, username: lc }],
      state: 'lobby',
      results: [],
      sessionLeaderboard: [],
      clicked: new Set(),
      lightsOut: false,
      lightsOutAt: null,
      gameTimer: null,
      cleanupTimer: null,
    };
    socket.join(id);
    socket.data.roomId = id;
    socket.data.username = lc;
    socket.emit('room_created', { roomId: id });
    pushState(id);
    pushRoomList();
    L.room(`Created   [${id}] host=${lc} game=${gameType}`);
  });

  // JOIN ──────────────────────────────────────────────────────────────────────
  socket.on('join_room', ({ username, roomId }) => {
    const lc = username.toLowerCase();
    const r = rooms[roomId];

    if (!r) {
      L.warn(`join_room  [${roomId}] not found — requested by ${lc}`);
      return socket.emit('join_error', `Room "${roomId}" not found. Check the code.`);
    }

    if (r.cleanupTimer) {
      clearTimeout(r.cleanupTimer);
      r.cleanupTimer = null;
      L.room(`Reprieve  [${roomId}] cleanup cancelled (${lc} reconnected)`);
    }

    // RECONNECT: same username already in room
    const existing = r.players.find(p => p.username === lc);
    if (existing) {
      const oldId = existing.id;
      existing.id = socket.id;
      if (r.hostId === oldId) r.hostId = socket.id;
      if (r.clicked.has(oldId)) { r.clicked.delete(oldId); r.clicked.add(socket.id); }
      // Update registry
      registerUser(lc, socket.id);
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.username = lc;
      socket.emit('room_joined', { roomId, gameType: r.gameType, isHost: r.hostId === socket.id });
      pushState(roomId);
      pushSessionLeaderboard(roomId);
      pushPlayersList();
      L.ok(`Reconnect [${roomId}] ${lc} (${oldId.slice(0, 6)}→${socket.id.slice(0, 6)})`);
      return;
    }

    // NEW player — username must already be claimed (via claim_username)
    // Double-check it's actually this socket's claimed name
    if (socket.data.username !== lc) {
      return socket.emit('join_error', `Username mismatch. Please refresh and try again.`);
    }

    if (r.state !== 'lobby') {
      L.warn(`join_room  [${roomId}] blocked — state=${r.state}`);
      return socket.emit('join_error', 'Game already in progress.');
    }

    r.players.push({ id: socket.id, username: lc });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit('room_joined', { roomId, gameType: r.gameType, isHost: false });
    pushState(roomId);
    pushSessionLeaderboard(roomId);
    broadcast(roomId, 'sys', `${lc} joined.`);
    L.ok(`Joined    [${roomId}] ${lc} (${r.players.length} players)`);
  });

  // START ─────────────────────────────────────────────────────────────────────
  socket.on('start_game', () => {
    const r = roomOf(socket);
    if (!r || r.hostId !== socket.id || r.state !== 'lobby') return;
    r.state = 'starting';
    r.results = [];
    r.clicked = new Set();
    r.lightsOut = false;
    broadcast(r.id, 'game_starting');
    pushRoomList();
    pushPlayersList();
    setTimeout(() => startLights(r.id), 3600);
    L.game(`Start     [${r.id}] by ${socket.data.username} — ${r.players.length} drivers`);
  });

  // CLICK ─────────────────────────────────────────────────────────────────────
  socket.on('player_click', () => {
    const r = roomOf(socket);
    if (!r || r.clicked.has(socket.id)) return;
    if (r.state !== 'lights' && r.state !== 'ready') return;
    r.clicked.add(socket.id);

    if (!r.lightsOut) {
      r.results.push({ id: socket.id, username: socket.data.username, time: null, jump: true });
      socket.emit('you_jumped');
      L.warn(`JumpStart [${r.id}] ${socket.data.username}`);
    } else {
      const ms = Date.now() - r.lightsOutAt;
      r.results.push({ id: socket.id, username: socket.data.username, time: ms, jump: false });
      socket.emit('your_time', { time: ms });
      L.game(`Click     [${r.id}] ${socket.data.username} → ${ms}ms`);
    }

    if (r.clicked.size >= r.players.length) {
      clearTimeout(r.gameTimer);
      setTimeout(() => endGame(r.id), 600);
    }
  });

  // PLAY AGAIN ────────────────────────────────────────────────────────────────
  socket.on('play_again', () => {
    const r = roomOf(socket);
    if (!r || r.hostId !== socket.id) return;
    r.state = 'lobby';
    r.results = [];
    r.clicked = new Set();
    clearTimeout(r.gameTimer);
    broadcast(r.id, 'back_to_lobby');
    pushState(r.id);
    pushRoomList();
    pushPlayersList();
    L.room(`PlayAgain [${r.id}] by ${socket.data.username}`);
  });

  // GET ROOM LIST ──────────────────────────────────────────────────────────────
  socket.on('get_room_list', () => {
    socket.emit('room_list', Object.values(rooms)
      .filter(r => r.players.length >= 1 && r.state === 'lobby')
      .map(r => ({ id: r.id, gameType: r.gameType, playerCount: r.players.length, hostUsername: r.hostUsername })));
  });

  // DISCONNECT ────────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const username = socket.data?.username;
    L.sock(`Disconnect ${socket.id.slice(0, 8)} (${username || '?'})`);

    // Release username from global registry
    if (username) {
      const registeredId = userRegistry.get(username.toLowerCase());
      if (registeredId === socket.id) unregisterUser(username);
    }
    pushPlayersList();

    const rid = socket.data?.roomId;
    if (!rid || !rooms[rid]) return;

    const r = rooms[rid];
    const name = username || '?';
    const wasHost = r.hostId === socket.id;

    const playerIdx = r.players.findIndex(p => p.id === socket.id);
    if (playerIdx === -1) return;

    const isLastPlayer = r.players.length === 1;

    if (isLastPlayer) {
      scheduleCleanup(rid);
      L.room(`LastPlayer [${rid}] ${name} — keeping entry (grace 15s for reconnect)`);
      return;
    }

    r.players.splice(playerIdx, 1);

    if (wasHost) {
      r.hostId = r.players[0].id;
      io.to(r.hostId).emit('you_are_host');
      L.room(`NewHost   [${rid}] → ${r.players[0].username}`);
    }

    pushState(rid);
    pushRoomList();
    broadcast(rid, 'sys', `${name} left.`);
    L.room(`Left      [${rid}] ${name} (${r.players.length} remaining)`);
  });
});

// ── Session leaderboard ───────────────────────────────────────────────────────
function pushSessionLeaderboard(roomId) {
  const r = rooms[roomId];
  if (!r) return;
  broadcast(roomId, 'session_leaderboard', r.sessionLeaderboard);
}

function updateSessionLeaderboard(roomId, results) {
  const r = rooms[roomId];
  if (!r) return;
  results.forEach(res => {
    if (res.jump || res.dns || res.time === null) return;
    const existing = r.sessionLeaderboard.find(e => e.username === res.username);
    if (!existing) {
      r.sessionLeaderboard.push({ username: res.username, bestTime: res.time, runs: 1 });
    } else {
      if (res.time < existing.bestTime) existing.bestTime = res.time;
      existing.runs++;
    }
  });
  r.sessionLeaderboard.sort((a, b) => a.bestTime - b.bestTime);
  pushSessionLeaderboard(roomId);
}

// ── Game logic ────────────────────────────────────────────────────────────────
function startLights(roomId) {
  const r = rooms[roomId];
  if (!r) return;
  r.state = 'lights';
  broadcast(roomId, 'lights_begin');

  let i = 0;
  const tick = setInterval(() => {
    broadcast(roomId, 'light_on', { i });
    i++;
    if (i === 5) {
      clearInterval(tick);
      const delay = Math.round(600 + Math.random() * 2800);
      L.game(`AllOn     [${roomId}] extinguish in ${delay}ms`);
      setTimeout(() => {
        r.state = 'ready';
        r.lightsOut = true;
        r.lightsOutAt = Date.now();
        broadcast(roomId, 'lights_out');
        L.game(`LightsOut [${roomId}] GO!`);
        r.gameTimer = setTimeout(() => endGame(roomId), 8000);
      }, delay);
    }
  }, 850);
}

function endGame(roomId) {
  const r = rooms[roomId];
  if (!r || r.state === 'finished') return;
  r.state = 'finished';

  r.players.forEach(p => {
    if (!r.clicked.has(p.id))
      r.results.push({ id: p.id, username: p.username, time: null, jump: false, dns: true });
  });

  const sorted = r.results.slice().sort((a, b) => {
    if (a.dns && !b.dns) return 1;
    if (!a.dns && b.dns) return -1;
    if (a.jump && !b.jump) return 1;
    if (!a.jump && b.jump) return -1;
    if (a.time !== null && b.time !== null) return a.time - b.time;
    return 0;
  });

  broadcast(roomId, 'results', { results: sorted });
  updateSessionLeaderboard(roomId, sorted);

  const w = sorted[0];
  L.game(`Results   [${roomId}] P1=${w?.username} ${w?.jump ? 'JUMP' : w?.dns ? 'DNS' : (w?.time + 'ms')}`);
}

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  let lan = 'localhost';
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const net of ifaces)
      if (net.family === 'IPv4' && !net.internal) { lan = net.address; break; }

  console.log(`\n${C.bold}${C.white}  ██╗      █████╗ ███╗   ██╗ ██████╗${C.reset}`);
  console.log(`${C.bold}${C.white}  ██║     ██╔══██╗████╗  ██║██╔═████╗${C.reset}`);
  console.log(`${C.bold}${C.white}  ██║     ███████║██╔██╗ ██║██║██╔██║${C.reset}`);
  console.log(`${C.bold}${C.white}  ██║     ██╔══██║██║╚██╗██║████╔╝██║${C.reset}`);
  console.log(`${C.bold}${C.white}  ███████╗██║  ██║██║ ╚████║╚██████╔╝${C.reset}`);
  console.log(`${C.bold}${C.white}  ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝${C.reset}\n`);
  console.log(`  ${C.green}▶${C.reset}  Local   → ${C.cyan}http://localhost:${PORT}${C.reset}`);
  console.log(`  ${C.green}▶${C.reset}  Network → ${C.cyan}http://${lan}:${PORT}${C.reset}  ${C.dim}← share this with friends${C.reset}\n`);
  console.log(`${C.dim}  ─────────────────────────────────────────────${C.reset}\n`);
  L.info('Server ready. Waiting for connections...\n');
});