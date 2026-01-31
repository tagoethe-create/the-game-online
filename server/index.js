const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const Redis = require("ioredis");

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL;
const ROOM_TTL_SECONDS = parseInt(process.env.ROOM_TTL_SECONDS || "86400", 10);

if (!REDIS_URL) {
  console.error("❌ Missing REDIS_URL env var");
  process.exit(1);
}

// Upstash requires TLS -> rediss://...
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: false
});

redis.on("connect", () => console.log("✅ Redis connected"));
redis.on("error", (e) => console.error("❌ Redis error:", e?.message || e));

const app = express();
app.use(cors({ origin: "*" }));

app.get("/", (_req, res) => res.send("OK"));
app.get("/health", async (_req, res) => {
  try {
    await redis.ping();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
app.get("/room/:code", async (req, res) => {
  try {
    const room = (req.params.code || "").trim();
    if (!room) return res.json({ room: "", exists: false });

    const raw = await redis.get(roomKey(room));
    res.json({ room, exists: !!raw });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const roomKey = (room) => `thegame:room:${room}`;
const statsKey = (token) => `thegame:stats:${token}`;

const socketIndex = new Map();

const HAND_SIZE = 6;
const MIN_CARD = 2;
const MAX_CARD = 99;

async function loadRoom(room) {
  const raw = await redis.get(roomKey(room));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveRoom(room, game) {
  await redis.set(roomKey(room), JSON.stringify(game), "EX", ROOM_TTL_SECONDS);
}

async function getStats(token) {
  const raw = await redis.get(statsKey(token));
  if (!raw) return { games: 0, wins: 0, losses: 0 };
  try {
    const s = JSON.parse(raw);
    return { games: s.games || 0, wins: s.wins || 0, losses: s.losses || 0 };
  } catch {
    return { games: 0, wins: 0, losses: 0 };
  }
}

async function setStats(token, stats) {
  await redis.set(statsKey(token), JSON.stringify(stats), "EX", ROOM_TTL_SECONDS * 7);
}

function newShuffledDeck() {
  const deck = [];
  for (let c = MIN_CARD; c <= MAX_CARD; c++) deck.push(c);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function canPlayOnPile(card, pileName, pileValue) {
  return pileName.startsWith("up")
    ? (card > pileValue || card === pileValue - 10)
    : (card < pileValue || card === pileValue + 10);
}

function anyLegalMoveForToken(game, token) {
  const hand = game.players?.[token]?.hand || [];
  for (const c of hand) {
    for (const pileName of Object.keys(game.piles)) {
      if (canPlayOnPile(c, pileName, game.piles[pileName])) return true;
    }
  }
  return false;
}

function anyLegalMoveForAnyone(game) {
  for (const t of Object.keys(game.players || {})) {
    if (game.players[t]?.connected && anyLegalMoveForToken(game, t)) return true;
  }
  return false;
}

function minPlaysThisTurn(game) {
  return game.deck.length === 0 ? 1 : 2;
}

function nextConnectedToken(game, currentToken) {
  const tokens = Object.keys(game.players || {});
  if (tokens.length === 0) return null;
  const idx = tokens.indexOf(currentToken);
  for (let k = 1; k <= tokens.length; k++) {
    const cand = tokens[(idx + k) % tokens.length];
    if (game.players[cand]?.connected) return cand;
  }
  return tokens[(idx + 1) % tokens.length];
}

function publicState(game) {
  const playersPublic = {};
  for (const [t, p] of Object.entries(game.players || {})) {
    playersPublic[t] = { name: p.name || "", connected: !!p.connected };
  }
  return {
    room: game.room,
    maxPlayers: game.maxPlayers,
    status: game.status,
    piles: game.piles,
    deckCount: game.deck.length,
    turnToken: game.turnToken,
    playedThisTurn: game.playedThisTurn || {},
    pilePings: game.pilePings || {},
    start: game.start || null,
    players: playersPublic
  };
}

async function emitState(room, game) {
  io.to(room).emit("state", publicState(game));
}

async function emitHandAndStats(socket, game, token) {
  socket.emit("hand", game.players?.[token]?.hand || []);
  socket.emit("stats", await getStats(token));
}

async function createRoom(room, maxPlayers) {
  const existing = await loadRoom(room);
  if (existing) {
    if (existing.status === "waiting") {
      existing.maxPlayers = maxPlayers;
      await saveRoom(room, existing);
    }
    return existing;
  }

  const game = {
    room,
    maxPlayers,
    status: "waiting",
    createdAt: Date.now(),
    deck: [],
    piles: { up1: 1, up2: 1, down1: 100, down2: 100 },
    players: {},
    turnToken: null,
    playedThisTurn: {},
    pilePings: {},
    start: null
  };

  await saveRoom(room, game);
  return game;
}

async function startChoosingIfReady(game) {
  if (game.status !== "waiting") return game;
  const tokens = Object.keys(game.players || {});
  if (tokens.length < game.maxPlayers) return game;

  game.deck = newShuffledDeck();
  game.piles = { up1: 1, up2: 1, down1: 100, down2: 100 };
  game.turnToken = null;
  game.playedThisTurn = {};
  game.pilePings = {};
  game.start = { made: {}, pref: {} };

  for (const t of tokens) {
    game.players[t].hand = [];
    for (let i = 0; i < HAND_SIZE && game.deck.length > 0; i++) {
      game.players[t].hand.push(game.deck.pop());
    }
  }

  game.status = "choosing_start";
  await saveRoom(game.room, game);
  return game;
}

async function decideStarterIfAllMade(game) {
  if (game.status !== "choosing_start") return game;
  const tokens = Object.keys(game.players || {});
  const made = game.start?.made || {};
  const madeCount = tokens.filter((t) => !!made[t]).length;
  if (madeCount < tokens.length) return game;

  const can = tokens.filter((t) => game.start?.pref?.[t] === "can");
  const pool = can.length > 0 ? can : tokens;
  const starter = pool[Math.floor(Math.random() * pool.length)];

  game.status = "playing";
  game.turnToken = starter;
  game.playedThisTurn = {};
  await saveRoom(game.room, game);
  return game;
}

async function checkWinLose(game) {
  const deckEmpty = game.deck.length === 0;
  const handsEmpty = Object.values(game.players || {}).every((p) => (p.hand || []).length === 0);

  if (deckEmpty && handsEmpty) {
    if (game.status !== "win") {
      game.status = "win";
      for (const t of Object.keys(game.players || {})) {
        const s = await getStats(t);
        s.games++; s.wins++;
        await setStats(t, s);
      }
    }
    await saveRoom(game.room, game);
    return game;
  }

  const cardsRemain = !handsEmpty || !deckEmpty;
  if (cardsRemain && !anyLegalMoveForAnyone(game)) {
    if (game.status !== "lose") {
      game.status = "lose";
      for (const t of Object.keys(game.players || {})) {
        const s = await getStats(t);
        s.games++; s.losses++;
        await setStats(t, s);
      }
    }
    await saveRoom(game.room, game);
    return game;
  }

  return game;
}

/* ------------ socket events ------------ */
io.on("connection", (socket) => {
  socket.on("keepAlive", () => {
  // absichtlich leer
});

  socket.on("create", async ({ room, maxPlayers }) => {
    try {
      if (!room) return;
      maxPlayers = Math.max(2, Math.min(4, parseInt(maxPlayers || "2", 10)));
      const game = await createRoom(room.trim(), maxPlayers);
      await emitState(game.room, game);
    } catch (e) {
      socket.emit("errorMsg", "Serverfehler beim Erstellen der Lobby.");
    }
  });

  socket.on("join", async ({ room, name, token }) => {
    try {
      room = (room || "").trim();
      token = (token || "").trim();
      name = (name || "").trim();
      if (!room || !token) return;

      let game = await loadRoom(room);
      if (!game) return socket.emit("errorMsg", "Lobby existiert nicht (erst erstellen).");

      const tokens = Object.keys(game.players || {});
      const isKnown = !!game.players?.[token];
      if (!isKnown && tokens.length >= game.maxPlayers) return socket.emit("errorMsg", "Lobby ist voll.");

      if (!game.players) game.players = {};
      if (!game.players[token]) {
        game.players[token] = { name: name || "", hand: [], connected: true, socketId: socket.id };
      } else {
        if (name) game.players[token].name = name;
        game.players[token].connected = true;
        game.players[token].socketId = socket.id;
      }

      socket.join(room);
      socketIndex.set(socket.id, { room, token });

      game = await startChoosingIfReady(game);
      await saveRoom(room, game);

      await emitState(room, game);
      await emitHandAndStats(socket, game, token);
    } catch (e) {
      socket.emit("errorMsg", "Serverfehler beim Beitreten.");
    }
  });

  socket.on("startPref", async ({ room, token, pref }) => {
    try {
      room = (room || "").trim();
      token = (token || "").trim();
      if (!room || !token) return;

      let game = await loadRoom(room);
      if (!game) return socket.emit("errorMsg", "Lobby existiert nicht (erst erstellen).");
      if (game.status !== "choosing_start") return;

      game.start = game.start || { made: {}, pref: {} };
      game.start.made[token] = true;
      game.start.pref[token] = (pref === "can") ? "can" : "not";

      game = await decideStarterIfAllMade(game);
      await saveRoom(room, game);

      await emitState(room, game);
      socket.emit("stats", await getStats(token));

      for (const [t, p] of Object.entries(game.players || {})) {
        if (p.socketId) {
          const s = io.sockets.sockets.get(p.socketId);
          if (s) s.emit("hand", p.hand || []);
        }
      }
    } catch {
      socket.emit("errorMsg", "Serverfehler bei Startwahl.");
    }
  });

  socket.on("pilePing", async ({ room, pile, type }) => {
    try {
      room = (room || "").trim();
      if (!room) return;
      let game = await loadRoom(room);
      if (!game) return socket.emit("errorMsg", "Lobby existiert nicht (erst erstellen).");

      if (!["up1","up2","down1","down2"].includes(pile)) return;
      if (!["have","dont"].includes(type)) return;

      game.pilePings = game.pilePings || {};
      game.pilePings[pile] = { type, ts: Date.now() };

      await saveRoom(room, game);
      await emitState(room, game);
    } catch {
      socket.emit("errorMsg", "Serverfehler beim Ping.");
    }
  });

  socket.on("play", async ({ room, token, card, pile }) => {
    try {
      room = (room || "").trim();
      token = (token || "").trim();
      card = parseInt(card, 10);
      if (!room || !token || !Number.isFinite(card)) return;

      let game = await loadRoom(room);
      if (!game) return socket.emit("errorMsg", "Lobby existiert nicht (erst erstellen).");
      if (game.status !== "playing") return;
      if (game.turnToken !== token) return socket.emit("errorMsg", "Nicht dein Zug.");

      const p = game.players?.[token];
      if (!p) return socket.emit("errorMsg", "Spieler unbekannt.");
      if (!p.hand.includes(card)) return socket.emit("errorMsg", "Karte nicht in deiner Hand.");
      if (!(pile in game.piles)) return socket.emit("errorMsg", "Ungültiger Stapel.");

      const pileValue = game.piles[pile];
      if (!canPlayOnPile(card, pile, pileValue)) return socket.emit("errorMsg", "Dort nicht erlaubt.");

      game.piles[pile] = card;
      p.hand = p.hand.filter((x) => x !== card);

      game.playedThisTurn = game.playedThisTurn || {};
      game.playedThisTurn[token] = (game.playedThisTurn[token] || 0) + 1;

      await saveRoom(room, game);

      await emitState(room, game);
      socket.emit("hand", p.hand || []);

      game = await checkWinLose(game);
      await emitState(room, game);

      for (const [t, pl] of Object.entries(game.players || {})) {
        if (pl.socketId) {
          const s = io.sockets.sockets.get(pl.socketId);
          if (s) s.emit("stats", await getStats(t));
        }
      }
    } catch {
      socket.emit("errorMsg", "Serverfehler beim Spielen.");
    }
  });

  socket.on("endTurn", async ({ room, token }) => {
    try {
      room = (room || "").trim();
      token = (token || "").trim();
      if (!room || !token) return;

      let game = await loadRoom(room);
      if (!game) return socket.emit("errorMsg", "Lobby existiert nicht (erst erstellen).");
      if (game.status !== "playing") return;
      if (game.turnToken !== token) return socket.emit("errorMsg", "Nicht dein Zug.");

      const p = game.players?.[token];
      if (!p) return socket.emit("errorMsg", "Spieler unbekannt.");

      const played = game.playedThisTurn?.[token] || 0;
      const minPlays = minPlaysThisTurn(game);
      const canMove = anyLegalMoveForToken(game, token);

      if (played < minPlays && canMove) {
        return socket.emit("errorMsg", `Du musst mindestens ${minPlays} Karte${minPlays>1?"n":""} spielen (wenn möglich).`);
      }

      while (p.hand.length < HAND_SIZE && game.deck.length > 0) {
        p.hand.push(game.deck.pop());
      }

      game.playedThisTurn[token] = 0;
      game.turnToken = nextConnectedToken(game, token);

      await saveRoom(room, game);

      await emitState(room, game);
      for (const [t, pl] of Object.entries(game.players || {})) {
        if (pl.socketId) {
          const s = io.sockets.sockets.get(pl.socketId);
          if (s) s.emit("hand", pl.hand || []);
        }
      }

      game = await checkWinLose(game);
      await emitState(room, game);

      for (const [t, pl] of Object.entries(game.players || {})) {
        if (pl.socketId) {
          const s = io.sockets.sockets.get(pl.socketId);
          if (s) s.emit("stats", await getStats(t));
        }
      }
    } catch {
      socket.emit("errorMsg", "Serverfehler beim Zug beenden.");
    }
  });

  socket.on("rematch", async ({ room }) => {
    try {
      room = (room || "").trim();
      if (!room) return;
      let game = await loadRoom(room);
      if (!game) return socket.emit("errorMsg", "Lobby existiert nicht (erst erstellen).");

      game.status = "waiting";
      game.deck = [];
      game.piles = { up1: 1, up2: 1, down1: 100, down2: 100 };
      game.turnToken = null;
      game.playedThisTurn = {};
      game.pilePings = {};
      game.start = null;

      for (const t of Object.keys(game.players || {})) game.players[t].hand = [];

      game = await startChoosingIfReady(game);
      await saveRoom(room, game);
      await emitState(room, game);

      for (const [t, pl] of Object.entries(game.players || {})) {
        if (pl.socketId) {
          const s = io.sockets.sockets.get(pl.socketId);
          if (s) {
            s.emit("hand", pl.hand || []);
            s.emit("stats", await getStats(t));
          }
        }
      }
    } catch {
      socket.emit("errorMsg", "Serverfehler beim Rematch.");
    }
  });

  socket.on("disconnect", async () => {
    const entry = socketIndex.get(socket.id);
    socketIndex.delete(socket.id);
    if (!entry) return;

    const { room, token } = entry;
    try {
      const game = await loadRoom(room);
      if (!game) return;
      if (game.players?.[token]) {
        game.players[token].connected = false;
        game.players[token].socketId = null;
        await saveRoom(room, game);
        await emitState(room, game);
      }
    } catch {}
  });
});

server.listen(PORT, () => console.log(`✅ Server listening on ${PORT}`));
