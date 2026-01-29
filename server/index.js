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
    stats: { games: 0, wins: 0, losses: 0 } // pro Lobby
  };
}

function isValid(card, pile, piles) {
  const top = piles[pile];
  if (pile.startsWith("up")) {
    return card > top || card === top - 10;
  } else {
    return card < top || card === top + 10;
  }
}

function anyLegalMoveForPlayer(game, pid) {
  const hand = game.players[pid]?.hand || [];
  for (const card of hand) {
    for (const p in game.piles) {
      if (isValid(card, p, game.piles)) return true;
    }
  }
  return false;
}

function anyLegalMoveForAnyone(game) {
  for (const pid in game.players) {
    if (anyLegalMoveForPlayer(game, pid)) return true;
  }
  return false;
}

function refillHand(game, pid) {
  const player = game.players[pid];
  if (!player) return;
  while (player.hand.length < game.handSize && game.deck.length > 0) {
    player.hand.push(game.deck.pop());
  }
}

function emitState(room) {
  const game = games[room];
  if (!game) return;

  // Minimale “Public View” (trotzdem: Hände werden pro Client gefiltert)
  io.to(room).emit("state", {
    room,
    status: game.status,
    maxPlayers: game.maxPlayers,
    handSize: game.handSize,
    deckCount: game.deck.length,
    piles: game.piles,
    turn: game.turn,
    playedThisTurn: game.playedThisTurn,
    players: Object.fromEntries(
      Object.entries(game.players).map(([id, p]) => [id, { name: p.name, handCount: p.hand.length }])
    ),
    stats: game.stats
  });

  // Jeder bekommt zusätzlich seine Hand
  for (const pid in game.players) {
    const sock = io.sockets.sockets.get(pid);
    if (sock) {
      sock.emit("hand", game.players[pid].hand);
    }
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
    const game = games[room];
    if (!game) return socket.emit("errorMsg", "Lobby existiert nicht (erst erstellen).");

    if (Object.keys(game.players).length >= game.maxPlayers) {
      return socket.emit("errorMsg", "Lobby ist voll.");
    }

    socket.join(room);

    game.players[socket.id] = {
      name: (name || "Spieler").toString().slice(0, 18),
      hand: []
    };
    game.playedThisTurn[socket.id] = 0;

    // Initiale Hand
    refillHand(game, socket.id);

    // Turn setzen, sobald Spiel startet
    if (game.status === "waiting" && Object.keys(game.players).length === game.maxPlayers) {
      game.status = "playing";
      game.turn = Object.keys(game.players)[0];
      // playedThisTurn ist bereits 0
    }

    emitState(room);
  });

  socket.on("ping", ({ room, type }) => {
    const game = games[room];
    if (!game) return;
    const sender = game.players[socket.id]?.name || "Spieler";
    io.to(room).emit("ping", { from: sender, type: type || "?" });
  });

  socket.on("play", ({ room, card, pile }) => {
    const game = games[room];
    if (!game || game.status !== "playing") return;
    if (game.turn !== socket.id) return;

    const player = game.players[socket.id];
    if (!player) return;

    const c = Number(card);
    if (!player.hand.includes(c)) return;
    if (!isValid(c, pile, game.piles)) return;

    // Karte legen
    game.piles[pile] = c;
    player.hand = player.hand.filter((x) => x !== c);
    game.playedThisTurn[socket.id] = (game.playedThisTurn[socket.id] || 0) + 1;

    // ✅ WICHTIG: NICHT nachziehen hier!

    emitState(room);
  });

  socket.on("endTurn", ({ room }) => {
    const game = games[room];
    if (!game || game.status !== "playing") return;
    if (game.turn !== socket.id) return;

    const played = game.playedThisTurn[socket.id] || 0;

    // Wenn <2 gespielt: nur erlauben, wenn Spieler wirklich keinen legalen Zug mehr hat -> dann LOSE
    if (played < 2) {
      if (anyLegalMoveForPlayer(game, socket.id)) {
        return socket.emit("errorMsg", "Du musst mindestens 2 Karten spielen (wenn möglich).");
      } else {
        // kann nicht 2 spielen -> Spiel verloren
        game.status = "lose";
        game.stats.games += 1;
        game.stats.losses += 1;
        emitState(room);
        return;
      }
    }

    // ✅ JETZT erst auffüllen
    refillHand(game, socket.id);

    // Win/Lose prüfen
    const ids = Object.keys(game.players);

    const allHandsEmpty = ids.every((id) => (game.players[id]?.hand.length || 0) === 0);
    if (game.deck.length === 0 && allHandsEmpty) {
      game.status = "win";
      game.stats.games += 1;
      game.stats.wins += 1;
      emitState(room);
      return;
    }

    if (!anyLegalMoveForAnyone(game)) {
      game.status = "lose";
      game.stats.games += 1;
      game.stats.losses += 1;
      emitState(room);
      return;
    }

    // Turn weitergeben
    game.playedThisTurn[socket.id] = 0;
    const idx = ids.indexOf(socket.id);
    game.turn = ids[(idx + 1) % ids.length];

    emitState(room);
  });

  socket.on("rematch", ({ room }) => {
    const old = games[room];
    if (!old) return;

    const stats = old.stats;
    const maxPlayers = old.maxPlayers;

    // Room neu initialisieren, Stats behalten
    newRoom(room, maxPlayers);
    games[room].stats = stats;

    // Spieler bleiben drin, müssen re-joinen? -> wir auto-rejoinen, indem wir sie wieder eintragen
    // (Socket-Room bleibt, aber Player-Map ist neu)
    // Einfach: Alle im Raum müssen „join“ nochmal klicken ist doof.
    // Besser: wir rekonstruieren aus aktuellen Room-Clients:
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
      const game = games[room];
      if (!game.players[socket.id]) continue;

      delete game.players[socket.id];
      delete game.playedThisTurn[socket.id];

      const ids = Object.keys(game.players);

      if (ids.length === 0) {
        // Leere Lobby aufräumen
        delete games[room];
        continue;
      }

      // Wenn der aktuelle Turn weg ist -> Turn auf ersten setzen
      if (game.turn === socket.id) {
        game.turn = ids[0];
      }

      // Wenn Spiel noch wartet, bleibt es warten
      if (game.status === "playing" && ids.length < game.maxPlayers) {
        // Optional: weiter spielen erlaubt. Wir lassen es weiterlaufen.
      }

      emitState(room);
    }
  });
});

server.listen(PORT, () => console.log("Server läuft auf Port", PORT));
