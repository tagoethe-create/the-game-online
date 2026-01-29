const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
let games = {};

function makeDeck() {
  const deck = [];
  for (let i = 2; i <= 99; i++) deck.push(i);
  deck.sort(() => Math.random() - 0.5);
  return deck;
}

function newRoom(room, maxPlayers) {
  games[room] = {
    deck: makeDeck(),
    piles: { up1: 1, up2: 1, down1: 100, down2: 100 },
    players: {},            // socketId -> { name, hand: [] }
    playedThisTurn: {},     // socketId -> number
    turn: null,
    status: "waiting",      // waiting | playing | win | lose
    maxPlayers: Math.max(2, Math.min(4, Number(maxPlayers) || 2)),
    handSize: 6,
    stats: { games: 0, wins: 0, losses: 0 }, // pro Lobby (bis Server-Neustart)
    pilePings: {}           // pile -> { type, from, ts }
  };
}

function isValid(card, pile, piles) {
  const top = piles[pile];
  if (pile.startsWith("up")) return card > top || card === top - 10;
  return card < top || card === top + 10;
}

function anyLegalMoveForPlayer(game, pid) {
  const hand = game.players[pid]?.hand || [];
  for (const c of hand) for (const p in game.piles) if (isValid(c, p, game.piles)) return true;
  return false;
}

function anyLegalMoveForAnyone(game) {
  for (const pid in game.players) if (anyLegalMoveForPlayer(game, pid)) return true;
  return false;
}

function refillHand(game, pid) {
  const pl = game.players[pid];
  if (!pl) return;
  while (pl.hand.length < game.handSize && game.deck.length > 0) {
    pl.hand.push(game.deck.pop());
  }
}

function emitState(room) {
  const g = games[room];
  if (!g) return;

  io.to(room).emit("state", {
    room,
    status: g.status,
    maxPlayers: g.maxPlayers,
    deckCount: g.deck.length,
    piles: g.piles,
    turn: g.turn,
    playedThisTurn: g.playedThisTurn,
    pilePings: g.pilePings,
    players: Object.fromEntries(
      Object.entries(g.players).map(([id, p]) => [id, { name: p.name, handCount: p.hand.length }])
    ),
    stats: g.stats
  });

  for (const pid in g.players) {
    const s = io.sockets.sockets.get(pid);
    if (s) s.emit("hand", g.players[pid].hand);
  }
}

io.on("connection", (socket) => {
  socket.on("create", ({ room, maxPlayers }) => {
    if (!room) return;
    if (!games[room]) newRoom(room, maxPlayers);
    socket.join(room);
    emitState(room);
  });

  socket.on("join", ({ room, name }) => {
    const g = games[room];
    if (!g) return socket.emit("errorMsg", "Lobby existiert nicht (erst erstellen).");
    if (Object.keys(g.players).length >= g.maxPlayers) return socket.emit("errorMsg", "Lobby ist voll.");

    socket.join(room);
    g.players[socket.id] = { name: (name || "Spieler").toString().slice(0, 18), hand: [] };
    g.playedThisTurn[socket.id] = 0;

    refillHand(g, socket.id);

    if (g.status === "waiting" && Object.keys(g.players).length === g.maxPlayers) {
      g.status = "playing";
      g.turn = Object.keys(g.players)[0];
    }

    emitState(room);
  });

  // ✅ Stapel-Ping (👀 / 🚫)
  socket.on("pilePing", ({ room, pile, type }) => {
    const g = games[room];
    if (!g || !g.piles[pile]) return;

    const safeType = type === "dont" ? "dont" : "have";
    g.pilePings[pile] = { type: safeType, from: g.players[socket.id]?.name || "Spieler", ts: Date.now() };
    emitState(room);

    // Auto-clear nach 4s (nur wenn es derselbe Ping ist)
    const ts = g.pilePings[pile].ts;
    setTimeout(() => {
      const gg = games[room];
      if (!gg) return;
      if (gg.pilePings[pile]?.ts === ts) {
        delete gg.pilePings[pile];
        emitState(room);
      }
    }, 4000);
  });

  socket.on("play", ({ room, card, pile }) => {
    const g = games[room];
    if (!g || g.status !== "playing") return;
    if (g.turn !== socket.id) return;

    const pl = g.players[socket.id];
    if (!pl) return;

    const c = Number(card);
    if (!pl.hand.includes(c)) return;
    if (!isValid(c, pile, g.piles)) return;

    g.piles[pile] = c;
    pl.hand = pl.hand.filter((x) => x !== c);
    g.playedThisTurn[socket.id] = (g.playedThisTurn[socket.id] || 0) + 1;

    // ✅ NICHT nachziehen hier!
    emitState(room);
  });

  socket.on("endTurn", ({ room }) => {
    const g = games[room];
    if (!g || g.status !== "playing") return;
    if (g.turn !== socket.id) return;

    const played = g.playedThisTurn[socket.id] || 0;
    const minPlays = g.deck.length === 0 ? 1 : 2;

    // PASS erlaubt, wenn du keinen legalen Zug hast
    if (played < minPlays && anyLegalMoveForPlayer(g, socket.id)) {
      return socket.emit(
        "errorMsg",
        `Du musst mindestens ${minPlays} Karte${minPlays > 1 ? "n" : ""} spielen (wenn möglich).`
      );
    }

    // ✅ Jetzt erst auffüllen
    refillHand(g, socket.id);

    // WIN
    const ids = Object.keys(g.players);
    const allHandsEmpty = ids.every((id) => (g.players[id]?.hand.length || 0) === 0);
    if (g.deck.length === 0 && allHandsEmpty) {
      g.status = "win";
      g.stats.games += 1;
      g.stats.wins += 1;
      emitState(room);
      return;
    }

    // LOSE (nur wenn wirklich niemand mehr kann)
    if (!anyLegalMoveForAnyone(g)) {
      g.status = "lose";
      g.stats.games += 1;
      g.stats.losses += 1;
      emitState(room);
      return;
    }

    // Turn weitergeben
    g.playedThisTurn[socket.id] = 0;
    const idx = ids.indexOf(socket.id);
    g.turn = ids[(idx + 1) % ids.length];

    emitState(room);
  });

  socket.on("rematch", ({ room }) => {
    const old = games[room];
    if (!old) return;

    const stats = old.stats;
    const maxPlayers = old.maxPlayers;

    newRoom(room, maxPlayers);
    games[room].stats = stats;

    // Spieler im Raum rekonstruieren (ohne neues Join nötig)
    const clients = Array.from(io.sockets.adapter.rooms.get(room) || []);
    for (const sid of clients) {
      games[room].players[sid] = { name: "Spieler", hand: [] };
      games[room].playedThisTurn[sid] = 0;
      refillHand(games[room], sid);
    }

    if (Object.keys(games[room].players).length === games[room].maxPlayers) {
      games[room].status = "playing";
      games[room].turn = Object.keys(games[room].players)[0];
    } else {
      games[room].status = "waiting";
      games[room].turn = null;
    }

    emitState(room);
  });

  socket.on("disconnect", () => {
    for (const room of Object.keys(games)) {
      const g = games[room];
      if (!g.players[socket.id]) continue;

      delete g.players[socket.id];
      delete g.playedThisTurn[socket.id];

      const ids = Object.keys(g.players);
      if (ids.length === 0) {
        delete games[room];
        continue;
      }
      if (g.turn === socket.id) g.turn = ids[0];

      emitState(room);
    }
  });
});

server.listen(PORT, () => console.log("Server läuft auf Port", PORT));
