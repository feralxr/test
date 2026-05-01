const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ── logging ───────────────────────────────────────────────────────────────────
const C = { r: '\x1b[0m', d: '\x1b[2m', g: '\x1b[32m', c: '\x1b[36m', y: '\x1b[33m', red: '\x1b[31m', w: '\x1b[37m', b: '\x1b[1m' };
const ts = () => C.d + new Date().toTimeString().slice(0, 8) + C.r;
const L = {
  ok: m => console.log(`${ts()} ${C.g}[OK  ]${C.r} ${m}`),
  warn: m => console.log(`${ts()} ${C.y}[WARN]${C.r} ${m}`),
  game: m => console.log(`${ts()} ${C.g}[GAME]${C.r} ${m}`),
  room: m => console.log(`${ts()} ${C.w}[ROOM]${C.r} ${m}`),
  sock: m => console.log(`${ts()} ${C.d}[SOCK]${C.r} ${m}`),
};

// ── username registry — Maps lc-username → socketId ──────────────────────────
const userRegistry = new Map();
function userTaken(lc) {
  const sid = userRegistry.get(lc);
  return sid ? io.sockets.sockets.get(sid)?.connected === true : false;
}
function regUser(lc, sid) { userRegistry.set(lc, sid); }
function freeUser(lc) { if (lc) userRegistry.delete(lc); }

// ── rooms ─────────────────────────────────────────────────────────────────────
const rooms = {};

function makeCode() {
  const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 4 }, () => ch[Math.floor(Math.random() * ch.length)]).join(''); }
  while (rooms[c]);
  return c;
}

// Create a fresh room object — called on create AND on full reset between rounds
function makeRoom(id, gameType, hostId, hostUsername) {
  return {
    id, gameType,
    hostId, hostUsername,
    players: [],
    state: 'lobby',          // lobby | starting | lights | ready | finished
    lightsOut: false,
    lightsOutAt: null,
    clicked: new Set(),      // socketIds that have clicked this round
    results: [],
    sessionLeaderboard: [],
    // timers — ALL stored so they can be cancelled
    startTimer: null,      // setTimeout before startLights
    lightsTimer: null,      // setInterval ticking lights on
    goTimer: null,      // setTimeout for lights_out delay
    endTimer: null,      // setTimeout for auto-end
    cleanupTimer: null,      // setTimeout for empty-room cleanup
  };
}

// Cancel every game-phase timer in a room (safe to call anytime)
function cancelGameTimers(r) {
  if (r.startTimer) { clearTimeout(r.startTimer); r.startTimer = null; }
  if (r.lightsTimer) { clearInterval(r.lightsTimer); r.lightsTimer = null; }
  if (r.goTimer) { clearTimeout(r.goTimer); r.goTimer = null; }
  if (r.endTimer) { clearTimeout(r.endTimer); r.endTimer = null; }
}

// Reset round-level fields without touching session leaderboard or players
function resetRound(r) {
  cancelGameTimers(r);
  r.state = 'lobby';
  r.lightsOut = false;
  r.lightsOutAt = null;
  r.clicked = new Set();
  r.results = [];
}

// ── broadcast helpers ─────────────────────────────────────────────────────────
const bcast = (rid, ev, data) => io.to(rid).emit(ev, data);

function pushRoomState(rid) {
  const r = rooms[rid]; if (!r) return;
  bcast(rid, 'room_state', { id: r.id, gameType: r.gameType, hostId: r.hostId, players: r.players, state: r.state });
}

function pushRoomList() {
  io.emit('room_list', Object.values(rooms)
    .filter(r => r.players.length >= 1 && r.state === 'lobby')
    .map(r => ({ id: r.id, gameType: r.gameType, playerCount: r.players.length, hostUsername: r.hostUsername })));
}

function pushPlayersList() {
  const list = [];
  for (const [, sock] of io.sockets.sockets) {
    if (!sock.connected || !sock.data?.username) continue;
    const rid = sock.data.roomId || null;
    const room = rid ? rooms[rid] : null;
    list.push({ username: sock.data.username, roomId: rid, gameType: room?.gameType || null });
  }
  list.sort((a, b) => (!!a.roomId - !!b.roomId) || a.username.localeCompare(b.username));
  io.emit('players_list', list);
}

function pushSessionLB(rid) {
  const r = rooms[rid]; if (!r) return;
  bcast(rid, 'session_leaderboard', r.sessionLeaderboard);
}

function updateSessionLB(rid, results) {
  const r = rooms[rid]; if (!r) return;
  results.forEach(res => {
    if (res.jump || res.dns || res.time === null) return;
    const e = r.sessionLeaderboard.find(x => x.username === res.username);
    if (!e) r.sessionLeaderboard.push({ username: res.username, bestTime: res.time, runs: 1 });
    else { if (res.time < e.bestTime) e.bestTime = res.time; e.runs++; }
  });
  r.sessionLeaderboard.sort((a, b) => a.bestTime - b.bestTime);
  pushSessionLB(rid);
}

// ── game logic ────────────────────────────────────────────────────────────────
function startGame(rid) {
  const r = rooms[rid]; if (!r) return;

  // Reset round fields (cancels any stale timers from previous round)
  resetRound(r);
  r.state = 'starting';

  bcast(rid, 'game_starting');
  pushRoomList();   // room no longer in lobby
  pushPlayersList();

  // Wait 3.6s then begin the lights sequence
  r.startTimer = setTimeout(() => {
    r.startTimer = null;
    startLights(rid);
  }, 1000);

  L.game(`Start [${rid}] ${r.players.length} players`);
}

function startLights(rid) {
  const r = rooms[rid]; if (!r) return;
  r.state = 'lights';
  bcast(rid, 'lights_begin');

  let i = 0;
  r.lightsTimer = setInterval(() => {
    bcast(rid, 'light_on', { i });
    i++;
    if (i < 5) return;

    // All 5 lights on — stop interval, schedule random extinguish
    clearInterval(r.lightsTimer);
    r.lightsTimer = null;

    const delay = Math.round(600 + Math.random() * 2800);
    r.goTimer = setTimeout(() => {
      r.goTimer = null;
      r.state = 'ready';
      r.lightsOut = true;
      r.lightsOutAt = Date.now();
      bcast(rid, 'lights_out');
      L.game(`GO [${rid}]`);

      // Auto-end after 3s if not everyone clicked
      r.endTimer = setTimeout(() => {
        r.endTimer = null;
        endGame(rid);
      }, 3000);

    }, delay);
  }, 850);
}

function endGame(rid) {
  const r = rooms[rid]; if (!r) return;
  if (r.state === 'finished' || r.state === 'lobby') return;

  cancelGameTimers(r);   // kill any remaining timers
  r.state = 'finished';

  // DNS for anyone who never clicked
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

  bcast(rid, 'results', { results: sorted });
  updateSessionLB(rid, sorted);

  const w = sorted.find(x => !x.jump && !x.dns);
  L.game(`Results [${rid}] winner=${w?.username} ${w?.time}ms`);
}

// ── room cleanup ──────────────────────────────────────────────────────────────
function scheduleCleanup(rid) {
  const r = rooms[rid]; if (!r) return;
  if (r.cleanupTimer) clearTimeout(r.cleanupTimer);
  r.cleanupTimer = setTimeout(() => {
    const rr = rooms[rid]; if (!rr) return;
    const allGone = rr.players.every(p => !io.sockets.sockets.get(p.id)?.connected);
    if (rr.players.length === 0 || allGone) {
      cancelGameTimers(rr);
      delete rooms[rid];
      pushRoomList();
      L.room(`Cleaned [${rid}]`);
    }
  }, 15000);
}

// ── socket handlers ───────────────────────────────────────────────────────────
io.on('connection', socket => {
  L.sock(`+ ${socket.id.slice(0, 8)}`);

  // Send lobby room list on connect
  socket.emit('room_list', Object.values(rooms)
    .filter(r => r.players.length >= 1 && r.state === 'lobby')
    .map(r => ({ id: r.id, gameType: r.gameType, playerCount: r.players.length, hostUsername: r.hostUsername })));

  // ── claim_username ──────────────────────────────────────────────────────────
  socket.on('claim_username', ({ username }) => {
    const lc = username.toLowerCase();
    if (userTaken(lc)) {
      socket.emit('username_claim_result', { ok: false, reason: `"${lc}" is already taken on this network.` });
      return;
    }
    if (socket.data.username) freeUser(socket.data.username);
    regUser(lc, socket.id);
    socket.data.username = lc;
    socket.emit('username_claim_result', { ok: true, username: lc });
    pushPlayersList();
    L.ok(`claim "${lc}" ${socket.id.slice(0, 8)}`);
  });

  // ── create_room ─────────────────────────────────────────────────────────────
  socket.on('create_room', ({ username, gameType }) => {
    const lc = username.toLowerCase();
    const id = makeCode();
    const r = makeRoom(id, gameType, socket.id, lc);
    r.players.push({ id: socket.id, username: lc });
    rooms[id] = r;
    socket.join(id);
    socket.data.roomId = id;
    socket.data.username = lc;
    socket.emit('room_created', { roomId: id });
    pushRoomState(id);
    pushRoomList();
    L.room(`Created [${id}] host=${lc} game=${gameType}`);
  });

  // ── join_room ───────────────────────────────────────────────────────────────
  socket.on('join_room', ({ username, roomId }) => {
    const lc = username.toLowerCase();
    const r = rooms[roomId];

    if (!r) return socket.emit('join_error', `Room "${roomId}" not found.`);

    // Cancel cleanup grace if active
    if (r.cleanupTimer) { clearTimeout(r.cleanupTimer); r.cleanupTimer = null; }

    // Reconnect: same username already exists in room
    const existing = r.players.find(p => p.username === lc);
    if (existing) {
      const oldId = existing.id;
      existing.id = socket.id;
      if (r.hostId === oldId) r.hostId = socket.id;
      if (r.clicked.has(oldId)) { r.clicked.delete(oldId); r.clicked.add(socket.id); }
      regUser(lc, socket.id);
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.username = lc;
      socket.emit('room_joined', { roomId, gameType: r.gameType, isHost: r.hostId === socket.id });
      pushRoomState(roomId);
      pushSessionLB(roomId);
      pushPlayersList();
      L.ok(`Reconnect [${roomId}] ${lc}`);
      return;
    }

    // New join — must have claimed username on this socket
    if (socket.data.username !== lc)
      return socket.emit('join_error', 'Username mismatch. Please refresh.');

    if (r.state !== 'lobby')
      return socket.emit('join_error', 'Game already in progress.');

    r.players.push({ id: socket.id, username: lc });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = lc;
    socket.emit('room_joined', { roomId, gameType: r.gameType, isHost: false });
    pushRoomState(roomId);
    pushSessionLB(roomId);
    pushPlayersList();
    bcast(roomId, 'sys', `${lc} joined.`);
    L.ok(`Joined [${roomId}] ${lc} (${r.players.length})`);
  });

  // ── start_game ──────────────────────────────────────────────────────────────
  socket.on('start_game', () => {
    const r = rooms[socket.data?.roomId];
    if (!r || r.hostId !== socket.id || r.state !== 'lobby') return;
    startGame(r.id);
  });

  // ── player_click ────────────────────────────────────────────────────────────
  // Server is sole authority: only accepts clicks in 'lights' or 'ready' state,
  // and only one click per player per round (tracked by r.clicked Set).
  socket.on('player_click', () => {
    const r = rooms[socket.data?.roomId];
    if (!r) return;
    if (r.state !== 'lights' && r.state !== 'ready') return;  // wrong phase
    if (r.clicked.has(socket.id)) return;                       // already clicked

    r.clicked.add(socket.id);

    if (!r.lightsOut) {
      // Jump start
      r.results.push({ id: socket.id, username: socket.data.username, time: null, jump: true, dns: false });
      socket.emit('you_jumped');
      L.warn(`Jump [${r.id}] ${socket.data.username}`);
    } else {
      // Valid reaction
      const ms = Date.now() - r.lightsOutAt;
      r.results.push({ id: socket.id, username: socket.data.username, time: ms, jump: false, dns: false });
      socket.emit('your_time', { time: ms });
      L.game(`Click [${r.id}] ${socket.data.username} ${ms}ms`);
    }

    // If everyone has clicked, end immediately (with small delay for last event to land)
    if (r.clicked.size >= r.players.length) {
      cancelGameTimers(r);
      r.endTimer = setTimeout(() => { r.endTimer = null; endGame(r.id); }, 400);
    }
  });

  // ── play_again ──────────────────────────────────────────────────────────────
  socket.on('play_again', () => {
    const r = rooms[socket.data?.roomId];
    if (!r || r.hostId !== socket.id) return;
    resetRound(r);           // cancels ALL timers, resets state to lobby
    bcast(r.id, 'back_to_lobby');
    pushRoomState(r.id);
    pushRoomList();
    pushPlayersList();
    L.room(`PlayAgain [${r.id}]`);
  });

  // ── get_room_list ───────────────────────────────────────────────────────────
  socket.on('get_room_list', () => {
    socket.emit('room_list', Object.values(rooms)
      .filter(r => r.players.length >= 1 && r.state === 'lobby')
      .map(r => ({ id: r.id, gameType: r.gameType, playerCount: r.players.length, hostUsername: r.hostUsername })));
  });

  // ── disconnect ──────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const username = socket.data?.username;
    L.sock(`- ${socket.id.slice(0, 8)} (${username || '?'})`);

    if (username && userRegistry.get(username) === socket.id) freeUser(username);
    pushPlayersList();

    const rid = socket.data?.roomId;
    if (!rid || !rooms[rid]) return;
    const r = rooms[rid];

    const idx = r.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;

    if (r.players.length === 1) { scheduleCleanup(rid); return; }

    const wasHost = r.hostId === socket.id;
    r.players.splice(idx, 1);

    if (wasHost) {
      r.hostId = r.players[0].id;
      io.to(r.hostId).emit('you_are_host');
      L.room(`NewHost [${rid}] ${r.players[0].username}`);
    }

    // If the game was in progress and everyone remaining already clicked, end it
    if ((r.state === 'lights' || r.state === 'ready') && r.clicked.size >= r.players.length) {
      cancelGameTimers(r);
      r.endTimer = setTimeout(() => { r.endTimer = null; endGame(rid); }, 400);
    }

    pushRoomState(rid);
    pushRoomList();
    bcast(rid, 'sys', `${username || '?'} left.`);
  });
});

// ── start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  let lan = 'localhost';
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const iface of ifaces)
      if (iface.family === 'IPv4' && !iface.internal) { lan = iface.address; break; }

  console.log(`\n${C.b}${C.w}  ██╗      █████╗ ███╗   ██╗ ██████╗${C.r}`);
  console.log(`${C.b}${C.w}  ██║     ██╔══██╗████╗  ██║██╔═████╗${C.r}`);
  console.log(`${C.b}${C.w}  ██║     ███████║██╔██╗ ██║██║██╔██║${C.r}`);
  console.log(`${C.b}${C.w}  ██║     ██╔══██║██║╚██╗██║████╔╝██║${C.r}`);
  console.log(`${C.b}${C.w}  ███████╗██║  ██║██║ ╚████║╚██████╔╝${C.r}`);
  console.log(`${C.b}${C.w}  ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝${C.r}\n`);
  console.log(`  ${C.g}▶${C.r}  Local   → ${C.c}http://localhost:${PORT}${C.r}`);
  console.log(`  ${C.g}▶${C.r}  Network → ${C.c}http://${lan}:${PORT}${C.r}\n`);
});