const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

// ✅ Room bleibt nach "leer" noch bestehen (gegen Render/Reload Stress)
const ROOM_TTL_MS = 10 * 60 * 1000; // 10 Minuten

const rooms = {}; // roomCode -> game

function makeDeck() {
  const deck = [];
  for (let i = 2; i <= 99; i++) deck.push(i);
  deck.sort(() => Math.random() - 0.5);
  return deck;
}

function newRoom(room, maxPlayers) {
  rooms[room] = {
    room,
    maxPlayers: Math.max(2, Math.min(4, Number(maxPlayers) || 2)),
    status: "waiting", // waiting | choosing_start | playing | win | lose

    deck: makeDeck(),
    piles: { up1: 1, up2: 1, down1: 100, down2: 100 },
    handSize: 6,

    // ✅ Token-based players (not socket.id)
    players: {}, // token -> { name, hand, socketId, connected, lastSeen }

    turnToken: null,
    playedThisTurn: {}, // token -> number

    startPrefs: {}, // token -> "can" | "not" | null
    startChoiceMade: {}, // token -> boolean

    pilePings: {}, // pile -> { type, ts }

    stats: { games: 0, wins: 0, losses: 0 },

    emptySince: null
  };
}

function cleanupRooms() {
  const now = Date.now();
  for (const code of Object.keys(rooms)) {
    const g = rooms[code];
    const anyConnected = Object.values(g.players).some((p) => p.connected);
    if (anyConnected) {
      g.emptySince = null;
      continue;
    }
    if (g.emptySince == null) g.emptySince = now;
    if (now - g.emptySince > ROOM_TTL_MS) delete rooms[code];
  }
}
setInterval(cleanupRooms, 30 * 1000);

function isValid(card, pile, piles) {
  const top = piles[pile];
  if (pile.startsWith("up")) return card > top || card === top - 10;
  return card < top || card === top + 10;
}

function refillHand(game, token) {
  const pl = game.players[token];
  if (!pl) return;
  while (pl.hand.length < game.handSize && game.deck.length > 0) {
    pl.hand.push(game.deck.pop());
  }
}

function anyLegalMoveForToken(game, token) {
  const hand = game.players[token]?.hand || [];
  for (const c of hand) {
    for (const p in game.piles) {
      if (isValid(c, p, game.piles)) return true;
    }
  }
  return false;
}

function anyLegalMoveForAnyone(game) {
  for (const t of Object.keys(game.players)) {
    if (anyLegalMoveForToken(game, t)) return true;
  }
  return false;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function allStartChoicesMade(game) {
  const tokens = Object.keys(game.players);
  return tokens.length > 0 && tokens.every((t) => game.startChoiceMade[t]);
}

function finalizeStartingPlayer(game) {
  const tokens = Object.keys(game.players);
  const can = tokens.filter((t) => game.startPrefs[t] === "can");

  let starter = null;
  if (can.length === 1) starter = can[0];
  else if (can.length > 1) starter = pickRandom(can);
  else starter = pickRandom(tokens);

  game.turnToken = starter;
  game.status = "playing";
  for (const t of tokens) game.playedThisTurn[t] = 0;
}

function emitState(game) {
  const playersPublic = {};
  for (const [token, p] of Object.entries(game.players)) {
    playersPublic[token] = {
      name: p.name,
      handCount: p.hand.length,
      connected: !!p.connected
    };
  }

  io.to(game.room).emit("state", {
    room: game.room,
    status: game.status,
    maxPlayers: game.maxPlayers,
    deckCount: game.deck.length,
    piles: game.piles,
    turnToken: game.turnToken,
    playedThisTurn: game.playedThisTurn,
    pilePings: game.pilePings,
    players: playersPublic,
    stats: game.stats,
    start: { prefs: game.startPrefs, made: game.startChoiceMade }
  });

  // each player gets own hand
  for (const [token, p] of Object.entries(game.players)) {
    if (!p.socketId) continue;
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit("hand", p.hand);
  }
}

io.on("connection", (socket) => {
  function markDisconnectedEverywhere() {
    for (const g of Object.values(rooms)) {
      for (const [token, p] of Object.entries(g.players)) {
        if (p.socketId === socket.id) {
          p.connected = false;
          p.socketId = null;
          p.lastSeen = Date.now();

          // if it's their turn, pass to next connected if possible
          if (g.status === "playing" && g.turnToken === token) {
            const tokens = Object.keys(g.players);
            const idx = tokens.indexOf(token);

            let next = null;
            for (let k = 1; k <= tokens.length; k++) {
              const cand = tokens[(idx + k) % tokens.length];
              if (g.players[cand]?.connected) {
                next = cand;
                break;
              }
            }
            g.turnToken = next || tokens[0] || null;
          }

          emitState(g);
        }
      }
    }
  }

  socket.on("create", ({ room, maxPlayers }) => {
    if (!room) return;
    if (!rooms[room]) newRoom(room, maxPlayers);
    // create just ensures room exists
    emitState(rooms[room]);
  });

  socket.on("join", ({ room, name, token }) => {
    const g = rooms[room];
    if (!g) return socket.emit("errorMsg", "Lobby existiert nicht (erst erstellen).");
    if (!token) return socket.emit("errorMsg", "Fehlender Player-Token.");

    socket.join(room);

    // rejoin existing token
    if (g.players[token]) {
      g.players[token].name = (name || g.players[token].name || "Spieler").toString().slice(0, 18);
      g.players[token].socketId = socket.id;
      g.players[token].connected = true;
      g.players[token].lastSeen = Date.now();
      emitState(g);
      return;
    }

    // new player
    if (Object.keys(g.players).length >= g.maxPlayers) return socket.emit("errorMsg", "Lobby ist voll.");

    g.players[token] = {
      name: (name || "Spieler").toString().slice(0, 18),
      hand: [],
      socketId: socket.id,
      connected: true,
      lastSeen: Date.now()
    };

    g.playedThisTurn[token] = 0;
    g.startPrefs[token] = null;
    g.startChoiceMade[token] = false;

    refillHand(g, token);

    // when lobby full -> choose start
    if (g.status === "waiting" && Object.keys(g.players).length === g.maxPlayers) {
      g.status = "choosing_start";
      g.turnToken = null;
    }

    emitState(g);
  });

  socket.on("startPref", ({ room, token, pref }) => {
    const g = rooms[room];
    if (!g || g.status !== "choosing_start") return;
    if (!g.players[token]) return;

    g.startPrefs[token] = pref === "can" ? "can" : "not";
    g.startChoiceMade[token] = true;

    if (allStartChoicesMade(g)) finalizeStartingPlayer(g);
    emitState(g);
  });

  socket.on("pilePing", ({ room, pile, type }) => {
    const g = rooms[room];
    if (!g || !g.piles[pile]) return;

    const safeType = type === "dont" ? "dont" : "have";
    g.pilePings[pile] = { type: safeType, ts: Date.now() };
    emitState(g);

    const ts = g.pilePings[pile].ts;
    setTimeout(() => {
      const gg = rooms[room];
      if (!gg) return;
      if (gg.pilePings[pile]?.ts === ts) {
        delete gg.pilePings[pile];
        emitState(gg);
      }
    }, 4000);
  });

  socket.on("play", ({ room, token, card, pile }) => {
    const g = rooms[room];
    if (!g || g.status !== "playing") return;
    if (g.turnToken !== token) return;

    const pl = g.players[token];
    if (!pl) return;

    const c = Number(card);
    if (!pl.hand.includes(c)) return;
    if (!isValid(c, pile, g.piles)) return;

    g.piles[pile] = c;
    pl.hand = pl.hand.filter((x) => x !== c);
    g.playedThisTurn[token] = (g.playedThisTurn[token] || 0) + 1;

    emitState(g);
  });

  socket.on("endTurn", ({ room, token }) => {
    const g = rooms[room];
    if (!g || g.status !== "playing") return;
    if (g.turnToken !== token) return;

    const played = g.playedThisTurn[token] || 0;
    const minPlays = g.deck.length === 0 ? 1 : 2;

    // PASS allowed if no legal moves
    if (played < minPlays && anyLegalMoveForToken(g, token)) {
      return socket.emit("errorMsg", `Du musst mindestens ${minPlays} Karte${minPlays > 1 ? "n" : ""} spielen (wenn möglich).`);
    }

    // draw only now
    refillHand(g, token);

    const tokens = Object.keys(g.players);

    // WIN
    const allHandsEmpty = tokens.every((t) => (g.players[t]?.hand.length || 0) === 0);
    if (g.deck.length === 0 && allHandsEmpty) {
      g.status = "win";
      g.stats.games += 1;
      g.stats.wins += 1;
      emitState(g);
      return;
    }

    // LOSE
    if (!anyLegalMoveForAnyone(g)) {
      g.status = "lose";
      g.stats.games += 1;
      g.stats.losses += 1;
      emitState(g);
      return;
    }

    // next turn (token order)
    g.playedThisTurn[token] = 0;
    const idx = tokens.indexOf(token);
    g.turnToken = tokens[(idx + 1) % tokens.length];

    emitState(g);
  });

  socket.on("rematch", ({ room }) => {
    const old = rooms[room];
    if (!old) return;

    const stats = old.stats;
    const maxPlayers = old.maxPlayers;

    const keepPlayers = Object.entries(old.players).map(([token, p]) => ({
      token,
      name: p.name,
      socketId: p.socketId,
      connected: p.connected
    }));

    newRoom(room, maxPlayers);
    rooms[room].stats = stats;

    for (const kp of keepPlayers) {
      rooms[room].players[kp.token] = {
        name: kp.name || "Spieler",
        hand: [],
        socketId: kp.socketId,
        connected: kp.connected,
        lastSeen: Date.now()
      };
      rooms[room].playedThisTurn[kp.token] = 0;
      rooms[room].startPrefs[kp.token] = null;
      rooms[room].startChoiceMade[kp.token] = false;
      refillHand(rooms[room], kp.token);
    }

    if (Object.keys(rooms[room].players).length === rooms[room].maxPlayers) {
      rooms[room].status = "choosing_start";
      rooms[room].turnToken = null;
    }

    emitState(rooms[room]);
  });

  socket.on("disconnect", () => {
    markDisconnectedEverywhere();
  });
});

server.listen(PORT, () => console.log("Server läuft auf Port", PORT));
