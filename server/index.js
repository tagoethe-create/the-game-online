const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

let games = {};

function createGame(room) {
  let deck = [];
  for (let i = 2; i <= 99; i++) deck.push(i);
  deck.sort(() => Math.random() - 0.5);

  games[room] = {
    deck,
    piles: { up1: 1, up2: 1, down1: 100, down2: 100 },
    players: {},
    started: false
  };
}

function isValidMove(card, pile, piles) {
  if (pile.startsWith("up")) {
    return card > piles[pile] || card === piles[pile] - 10;
  } else {
    return card < piles[pile] || card === piles[pile] + 10;
  }
}

io.on("connection", socket => {

  socket.on("join", room => {
    if (!games[room]) createGame(room);

    const game = games[room];
    game.players[socket.id] = [];

    while (game.players[socket.id].length < 6 && game.deck.length) {
      game.players[socket.id].push(game.deck.pop());
    }

    socket.join(room);
    socket.emit("joined", socket.id);
    io.to(room).emit("state", game);
  });

  socket.on("play", ({ room, card, pile }) => {
    const game = games[room];
    if (!game) return;

    const hand = game.players[socket.id];
    if (!hand || !hand.includes(card)) return;

    if (!isValidMove(card, pile, game.piles)) return;

    game.piles[pile] = card;
    game.players[socket.id] = hand.filter(c => c !== card);

    while (game.players[socket.id].length < 6 && game.deck.length) {
      game.players[socket.id].push(game.deck.pop());
    }

    io.to(room).emit("state", game);
  });

  socket.on("disconnect", () => {
    for (const room in games) {
      delete games[room].players[socket.id];
    }
  });
});

server.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
