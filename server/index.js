const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
let games = {};

/* ---------- Helpers ---------- */
function makeDeck() {
  const d = [];
  for (let i = 2; i <= 99; i++) d.push(i);
  return d.sort(() => Math.random() - 0.5);
}

function newRoom(room, maxPlayers) {
  games[room] = {
    deck: makeDeck(),
    piles: { up1: 1, up2: 1, down1: 100, down2: 100 },
    players: {},
    playedThisTurn: {},
    turn: null,
    status: "waiting",
    maxPlayers: Math.max(2, Math.min(4, Number(maxPlayers) || 2)),
    handSize: 6,
    stats: { games: 0, wins: 0, losses: 0 },
    pilePings: {}
  };
}

function isValid(card, pile, piles) {
  const top = piles[pile];
  if (pile.startsWith("up")) return card > top || card === top - 10;
  return card < top || card === top + 10;
}

function anyLegalForPlayer(g, pid) {
  const h = g.players[pid]?.hand || [];
  return h.some(c => Object.keys(g.piles).some(p => isValid(c, p, g.piles)));
}

function anyLegalForAnyone(g) {
  return Object.keys(g.players).some(pid => anyLegalForPlayer(g, pid));
}

function refill(g, pid) {
  while (g.players[pid].hand.length < g.handSize && g.deck.length)
    g.players[pid].hand.push(g.deck.pop());
}

function emitState(room) {
  const g = games[room];
  if (!g) return;

  io.to(room).emit("state", {
    room,
    status: g.status,
    piles: g.piles,
    turn: g.turn,
    playedThisTurn: g.playedThisTurn,
    deckCount: g.deck.length,
    maxPlayers: g.maxPlayers,
    pilePings: g.pilePings,
    stats: g.stats,
    players: Object.fromEntries(
      Object.entries(g.players).map(([id, p]) => [id, { name: p.name, handCount: p.hand.length }])
    )
  });

  for (const pid in g.players) {
    io.to(pid).emit("hand", g.players[pid].hand);
  }
}

/* ---------- Socket ---------- */
io.on("connection", socket => {

  socket.on("create", ({ room, maxPlayers }) => {
    if (!room) return;
    if (!games[room] || Object.keys(games[room].players).length === 0)
      newRoom(room, maxPlayers);
    socket.join(room);
    emitState(room);
  });

  socket.on("join", ({ room, name }) => {
    const g = games[room];
    if (!g) return socket.emit("errorMsg", "Lobby existiert nicht.");
    if (Object.keys(g.players).length >= g.maxPlayers)
      return socket.emit("errorMsg", "Lobby ist voll.");

    g.players[socket.id] = { name: name || "Spieler", hand: [] };
    g.playedThisTurn[socket.id] = 0;
    socket.join(room);
    refill(g, socket.id);

    if (g.status === "waiting" && Object.keys(g.players).length === g.maxPlayers) {
      g.status = "playing";
      g.turn = Object.keys(g.players)[0];
    }
    emitState(room);
  });

  socket.on("play", ({ room, card, pile }) => {
    const g = games[room];
    if (!g || g.turn !== socket.id) return;
    if (!isValid(card, pile, g.piles)) return;

    g.piles[pile] = card;
    g.players[socket.id].hand =
      g.players[socket.id].hand.filter(c => c !== card);
    g.playedThisTurn[socket.id]++;
    emitState(room);
  });

  socket.on("endTurn", ({ room }) => {
    const g = games[room];
    if (!g || g.turn !== socket.id) return;

    const min = g.deck.length === 0 ? 1 : 2;
    const played = g.playedThisTurn[socket.id] || 0;

    if (played < min && anyLegalForPlayer(g, socket.id))
      return socket.emit("errorMsg", "Du musst noch Karten spielen.");

    refill(g, socket.id);

    if (g.deck.length === 0 &&
        Object.values(g.players).every(p => p.hand.length === 0)) {
      g.status = "win";
      g.stats.games++; g.stats.wins++;
      return emitState(room);
    }

    if (!anyLegalForAnyone(g)) {
      g.status = "lose";
      g.stats.games++; g.stats.losses++;
      return emitState(room);
    }

    g.playedThisTurn[socket.id] = 0;
    const ids = Object.keys(g.players);
    g.turn = ids[(ids.indexOf(socket.id) + 1) % ids.length];
    emitState(room);
  });

  socket.on("pilePing", ({ room, pile, type }) => {
    const g = games[room];
    if (!g) return;
    g.pilePings[pile] = { type, ts: Date.now() };
    emitState(room);
    setTimeout(() => {
      if (games[room]?.pilePings[pile]?.ts === g.pilePings[pile].ts) {
        delete games[room].pilePings[pile];
        emitState(room);
      }
    }, 4000);
  });

  socket.on("disconnect", () => {
    for (const r in games) {
      if (games[r].players[socket.id]) {
        delete games[r].players[socket.id];
        delete games[r].playedThisTurn[socket.id];
        if (Object.keys(games[r].players).length === 0) delete games[r];
        else emitState(r);
      }
    }
  });
});

server.listen(PORT, () => console.log("Server läuft:", PORT));
