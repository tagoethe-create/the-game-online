import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import Redis from "ioredis";

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL;
const ROOM_TTL_SECONDS = parseInt(process.env.ROOM_TTL_SECONDS || "86400", 10); // 24h default

if (!REDIS_URL) {
  console.error("❌ Missing REDIS_URL env var");
  process.exit(1);
}

const redis = new Redis(REDIS_URL, {
  tls: REDIS_URL.startsWith("rediss://") ? {} : undefined,
  maxRetriesPerRequest: 3,
});

const app = express();
app.use(cors({ origin: "*" }));
app.get("/", (_req, res) => res.send("OK"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const roomKey = (room) => `thegame:room:${room}`;
const statsKey = (token) => `thegame:stats:${token}`;

// socket.id -> { room, token }
const socketIndex = new Map();

/* ----------------- Game Constants ----------------- */
const HAND_SIZE = 6;
const MIN_CARD = 2;
const MAX_CARD = 99;

/* ----------------- Helpers: Redis ----------------- */
async function loadRoom(room) {
  const raw = await redis.get(roomKey(room));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveRoom(room, game) {
  await redis.set(roomKey(room), JSON.stringify(game), "EX", ROOM_TTL_SECONDS);
}

async function getStats(token) {
  const raw = await redis.get(statsKey(token));
  if (!raw) return { games: 0, wins: 0, losses: 0 };
  try {
    const s = JSON.parse(raw);
    return {
      games: s.games || 0,
      wins: s.wins || 0,
      losses: s.losses || 0,
    };
  } catch {
    return { games: 0, wins: 0, losses: 0 };
  }
}

async function setStats(token, stats) {
  await redis.set(statsKey(token), JSON.stringify(stats), "EX", ROOM_TTL_SECONDS * 7); // keep longer
}

/* ----------------- Helpers: Game ----------------- */
function newShuffledDeck() {
  const deck = [];
  for (let c = MIN_CARD; c <= MAX_CARD; c++) deck.push(c);
  // Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function canPlayOnPile(card, pileName, pileValue) {
  if (pileName.startsWith("up")) {
    return card > pileValue || card === pileValue - 10;
  }
  return card < pileValue || card === pileValue + 10;
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

function publicStateForRoom(game) {
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
    players: playersPublic,
  };
}

async function emitStateToRoom(room, game) {
  io.to(room).emit("state", publicStateForRoom(game));
}

async function emitHandAndStats(socket, game, token) {
  const hand = game.players?.[token]?.hand || [];
  socket.emit("hand", hand);
  socket.emit("stats", await getStats(token));
}

/* ----------------- Room Lifecycle ----------------- */
async function createRoom(room, maxPlayers) {
  const existing = await loadRoom(room);
  if (existing) {
    // allow updating maxPlayers only in waiting state
    if (existing.status === "waiting") {
      existing.maxPlayers = maxPlayers;
      await saveRoom(room, existing);
    }
    return existing;
  }

  const game = {
    room,
    maxPlayers,
    status: "waiting", // waiting -> choosing_start -> playing -> win/lose
    createdAt: Date.now(),

    // core game state
    deck: [],
    piles: { up1: 1, up2: 1, down1: 100, down2: 100 },

    // players
    players: {}, // token -> { name, hand:[], connected, socketId }
    turnToken: null,
    playedThisTurn: {},

    // coop helpers
    pilePings: {},

    // start-choice state
    start: null,
  };

  await saveRoom(room, game);
  return game;
}

async function startChoosingIfReady(game) {
  if (game.status !== "waiting") return game;

  const tokens = Object.keys(game.players || {});
  if (tokens.length < game.maxPlayers) return game;

  // initialize game
  game.deck = newShuffledDeck();
  game.piles = { up1: 1, up2: 1, down1: 100, down2: 100 };
  game.turnToken = null;
  game.playedThisTurn = {};
  game.pilePings = {};
  game.start = {
    made: {},
    pref: {}, // token -> "can" | "not"
  };

  // deal hands
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

  // who can?
  const can = tokens.filter((t) => game.start?.pref?.[t] === "can");
  const pool = can.length > 0 ? can : tokens;
  const starter = pool[Math.floor(Math.random() * pool.length)];

  game.status = "playing";
  game.turnToken = starter;
  game.playedThisTurn = {};
  await saveRoom(game.room, game);
  return game;
}

async function checkWinLoseAndPersist(game) {
  // win: deck empty AND all hands empty
  const deckEmpty = game.deck.length === 0;
  const handsEmpty = Object.values(game.players || {}).every((p) => (p.hand || []).length === 0);

  if (deckEmpty && handsEmpty) {
    if (game.status !== "win") {
      game.status = "win";
      // update stats for all players in room
      for (const t of Object.keys(game.players || {})) {
        const s = await getStats(t);
        s.games += 1;
        s.wins += 1;
        await setStats(t, s);
      }
    }
    await saveRoom(game.room, game);
    return game;
  }

  // lose: no legal moves for ANYONE (connected players) while cards remain (deck or hands)
  const cardsRemain = !handsEmpty || !deckEmpty;
  if (cardsRemain && !anyLegalMoveForAnyone(game)) {
    if (game.status !== "lose") {
      game.status = "lose";
      for (const t of Object.keys(game.players || {})) {
        const s = await getStats(t);
        s.games += 1;
        s.losses += 1;
        await setStats(t, s);
      }
    }
    await saveRoom(game.room, game);
    return game;
  }

  return game;
}

/* ----------------- Socket.IO ----------------- */
io.on("connection", (socket) => {
  socket.on("create", async ({ room, maxPlayers }) => {
    try {
      if (!room || typeof room !== "string") return;
      maxPlayers = Math.max(2, Math.min(4, parseInt(maxPlayers || "2", 10)));

      const game = await createRoom(room.trim(), maxPlayers);
      await emitStateToRoom(game.room, game);
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
      if (!game) {
        socket.emit("errorMsg", "Lobby existiert nicht (erst erstellen).");
        return;
      }

      // prevent overfill (except reconnecting known player)
      const tokens = Object.keys(game.players || {});
      const isKnown = !!game.players?.[token];
      if (!isKnown && tokens.length >= game.maxPlayers) {
        socket.emit("errorMsg", "Lobby ist voll.");
        return;
      }

      if (!game.players) game.players = {};
      if (!game.players[token]) {
        game.players[token] = {
          name: name || "",
          hand: [],
          connected: true,
          socketId: socket.id,
        };
      } else {
        // reconnect
        if (name) game.players[token].name = name;
        game.players[token].connected = true;
        game.players[token].socketId = socket.id;
      }

      socket.join(room);
      socketIndex.set(socket.id, { room, token });

      // if lobby is full and waiting -> start choosing
      game = await startChoosingIfReady(game);
      await saveRoom(room, game);

      // emit state & your hand/stats
      await emitStateToRoom(room, game);
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

      if (!game.start) game.start = { made: {}, pref: {} };
      game.start.made[token] = true;
      game.start.pref[token] = pref === "can" ? "can" : "not";

      game = await decideStarterIfAllMade(game);
      await saveRoom(room, game);

      // update all
      await emitStateToRoom(room, game);

      // update stats to that user too (still same)
      socket.emit("stats", await getStats(token));

      // send hands to all sockets (hand is private)
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

      if (!game.pilePings) game.pilePings = {};
      if (!["up1","up2","down1","down2"].includes(pile)) return;
      if (!["have","dont"].includes(type)) return;

      game.pilePings[pile] = { type, ts: Date.now() };
      await saveRoom(room, game);
      await emitStateToRoom(room, game);
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
      const hand = p.hand || [];

      if (!hand.includes(card)) return socket.emit("errorMsg", "Karte nicht in deiner Hand.");
      if (!game.piles || !(pile in game.piles)) return socket.emit("errorMsg", "Ungültiger Stapel.");

      const pileValue = game.piles[pile];
      if (!canPlayOnPile(card, pile, pileValue)) return socket.emit("errorMsg", "Dort nicht erlaubt.");

      // apply move
      game.piles[pile] = card;
      p.hand = hand.filter((x) => x !== card);

      if (!game.playedThisTurn) game.playedThisTurn = {};
      game.playedThisTurn[token] = (game.playedThisTurn[token] || 0) + 1;

      // clear pile ping if any (optional)
      // game.pilePings[pile] = null;

      await saveRoom(room, game);

      // emit updates
      await emitStateToRoom(room, game);
      socket.emit("hand", p.hand || []);

      // check win/lose
      game = await checkWinLoseAndPersist(game);
      await saveRoom(room, game);
      await emitStateToRoom(room, game);

      // stats updates to all
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

      // PASS logic: allowed if player truly has no legal moves
      const canMove = anyLegalMoveForToken(game, token);
      if (played < minPlays && canMove) {
        return socket.emit("errorMsg", `Du musst mindestens ${minPlays} Karte${minPlays > 1 ? "n" : ""} spielen (wenn möglich).`);
      }

      // draw up to HAND_SIZE (only at end of turn)
      while (p.hand.length < HAND_SIZE && game.deck.length > 0) {
        p.hand.push(game.deck.pop());
      }

      // reset per-turn counter
      if (!game.playedThisTurn) game.playedThisTurn = {};
      game.playedThisTurn[token] = 0;

      // advance to next connected player
      const next = nextConnectedToken(game, token);
      game.turnToken = next;

      await saveRoom(room, game);

      // emit state + hand updates
      await emitStateToRoom(room, game);

      // send hands to all (so everyone sees their refilled hand if it was them)
      for (const [t, pl] of Object.entries(game.players || {})) {
        if (pl.socketId) {
          const s = io.sockets.sockets.get(pl.socketId);
          if (s) s.emit("hand", pl.hand || []);
        }
      }

      // check lose/win after turn end
      game = await checkWinLoseAndPersist(game);
      await saveRoom(room, game);
      await emitStateToRoom(room, game);

      // stats updates
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

      // keep players & maxPlayers, reset to waiting (or directly to choosing if full)
      game.status = "waiting";
      game.deck = [];
      game.piles = { up1: 1, up2: 1, down1: 100, down2: 100 };
      game.turnToken = null;
      game.playedThisTurn = {};
      game.pilePings = {};
      game.start = null;

      // keep hands empty for fresh deal later
      for (const t of Object.keys(game.players || {})) {
        game.players[t].hand = [];
      }

      // if full already -> choosing start
      game = await startChoosingIfReady(game);

      await saveRoom(room, game);
      await emitStateToRoom(room, game);

      // push hands/stats
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
      let game = await loadRoom(room);
      if (!game) return;

      if (game.players?.[token]) {
        game.players[token].connected = false;
        game.players[token].socketId = null;
        await saveRoom(room, game);
        await emitStateToRoom(room, game);
      }
    } catch {
      // ignore
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server listening on ${PORT}`);
});
