const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

let games = {};

function newGame(room) {
  let deck = [];
  for (let i = 2; i <= 99; i++) deck.push(i);
  deck.sort(() => Math.random() - 0.5);

  games[room] = {
    deck,
    piles: { up1: 1, up2: 1, down1: 100, down2: 100 },
    players: {},
    turn: null,
    playedThisTurn: {},
    status: "playing"
  };
}

function isValid(card, pile, piles) {
  if (pile.startsWith("up")) {
    return card > piles[pile] || card === piles[pile] - 10;
  } else {
    return card < piles[pile] || card === piles[pile] + 10;
  }
}

function canPlayAny(game) {
  for (const pid in game.players) {
    for (const card of game.players[pid]) {
      for (const p in game.piles) {
        if (isValid(card, p, game.piles)) return true;
      }
    }
  }
  return false;
}

io.on("connection", socket => {

  socket.on("join", room => {
    if (!games[room]) newGame(room);
    const game = games[room];

    game.players[socket.id] = [];
    game.playedThisTurn[socket.id] = 0;

    while (game.players[socket.id].length < 6 && game.deck.length) {
      game.players[socket.id].push(game.deck.pop());
    }

    if (!game.turn) game.turn = socket.id;

    socket.join(room);
    io.to(room).emit("state", game);
  });

  socket.on("play", ({ room, card, pile }) => {
    const game = games[room];
    if (!game || game.status !== "playing") return;
    if (game.turn !== socket.id) return;

    const hand = game.players[socket.id];
    if (!hand.includes(card)) return;
    if (!isValid(card, pile, game.piles)) return;

    game.piles[pile] = card;
    game.players[socket.id] = hand.filter(c => c !== card);
    game.playedThisTurn[socket.id]++;

    while (game.players[socket.id].length < 6 && game.deck.length) {
      game.players[socket.id].push(game.deck.pop());
    }

    io.to(room).emit("state", game);
  });

  socket.on("endTurn", room => {
    const game = games[room];
    if (!game) return;

    if (game.playedThisTurn[socket.id] < 2) return;

    game.playedThisTurn[socket.id] = 0;
    const ids = Object.keys(game.players);
    const idx = ids.indexOf(socket.id);
    game.turn = ids[(idx + 1) % ids.length];

    if (
      game.deck.length === 0 &&
      ids.every(id => game.players[id].length === 0)
    ) {
      game.status = "win";
    } else if (!canPlayAny(game)) {
      game.status = "lose";
    }

    io.to(room).emit("state", game);
  });

  socket.on("rematch", room => {
    newGame(room);
    io.to(room).emit("state", games[room]);
  });

  socket.on("disconnect", () => {
    for (const room in games) {
      delete games[room].players[socket.id];
    }
  });
});

server.listen(PORT, () =>
  console.log("Server läuft auf Port", PORT)
);
