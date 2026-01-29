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
    pilePings: {} // pile -> { type, from, ts }
  };
}

function isValid(card, pile, piles) {
  const top = piles[pile];
  return pile.startsWith("up")
    ? card > top || card === top - 10
    : card < top || card === top + 10;
}

function anyLegalMoveForPlayer(game, pid) {
  const h = game.players[pid]?.hand || [];
  for (const c of h) for (const p in game.piles) if (isValid(c, p, game.piles)) return true;
  return false;
}

function anyLegalMoveForAnyone(game) {
  return Object.keys(game.players).some(pid => anyLegalMoveForPlayer(game, pid));
}

function refillHand(game, pid) {
  const pl = game.players[pid];
  while (pl && pl.hand.length < game.handSize && game.deck.length) {
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
      Object.entries(g
