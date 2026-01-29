const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
let games = {};

function makeDeck(){
  const d=[];
  for(let i=2;i<=99;i++) d.push(i);
  return d.sort(()=>Math.random()-0.5);
}

function newRoom(room,maxPlayers){
  games[room]={
    deck:makeDeck(),
    piles:{up1:1,up2:1,down1:100,down2:100},
    players:{},
    playedThisTurn:{},
    turn:null,
    status:"waiting",
    maxPlayers:Math.max(2,Math.min(4,Number(maxPlayers)||2)),
    handSize:6
  };
}

function isValid(card,pile,piles){
  const top=piles[pile];
  return pile.startsWith("up")
    ? card>top||card===top-10
    : card<top||card===top+10;
}

function refill(g,pid){
  while(g.players[pid].hand.length<g.handSize&&g.deck.length)
    g.players[pid].hand.push(g.deck.pop());
}

function anyLegal(g,pid){
  return g.players[pid].hand.some(c =>
    Object.keys(g.piles).some(p => isValid(c,p,g.piles))
  );
}

function anyLegalAnyone(g){
  return Object.keys(g.players).some(id=>anyLegal(g,id));
}

function emitState(room){
  const g=games[room];
  if(!g) return;

  io.to(room).emit("state",{
    room,
    piles:g.piles,
    turn:g.turn,
    status:g.status,
    deckCount:g.deck.length,
    playedThisTurn:g.playedThisTurn,
    players:Object.fromEntries(
      Object.entries(g.players).map(([id,p])=>[
        id,{name:p.name,handCount:p.hand.length}
      ])
    )
  });

  for(const id in g.players){
    io.to(id).emit("hand",g.players[id].hand);
  }
}

io.on("connection",socket=>{

  socket.on("create",({room,maxPlayers})=>{
    if(!games[room]) newRoom(room,maxPlayers);
    socket.join(room);
    emitState(room);
  });

  socket.on("join",({room,name})=>{
    const g=games[room];
    if(!g) return socket.emit("errorMsg","Lobby existiert nicht");
    if(Object.keys(g.players).length>=g.maxPlayers)
      return socket.emit("errorMsg","Lobby voll");

    g.players[socket.id]={name:name||"Spieler",hand:[]};
    g.playedThisTurn[socket.id]=0;
    socket.join(room);
    refill(g,socket.id);

    if(g.status==="waiting"&&Object.keys(g.players).length===g.maxPlayers){
      g.status="playing";
      g.turn=Object.keys(g.players)[0];
    }
    emitState(room);
  });

  socket.on("play",({room,card,pile})=>{
    const g=games[room];
    if(!g||g.turn!==socket.id) return;
    if(!isValid(card,pile,g.piles)) return;

    g.piles[pile]=card;
    g.players[socket.id].hand =
      g.players[socket.id].hand.filter(c=>c!==card);
    g.playedThisTurn[socket.id]++;
    emitState(room);
  });

  socket.on("endTurn",({room})=>{
    const g=games[room];
    if(!g||g.turn!==socket.id) return;

    const min=g.deck.length===0?1:2;
    if(g.playedThisTurn[socket.id]<min && anyLegal(g,socket.id))
      return socket.emit("errorMsg","Du musst noch Karten legen");

    refill(g,socket.id);

    if(!anyLegalAnyone(g)){
      g.status="lose";
      return emitState(room);
    }

    const ids=Object.keys(g.players);
    g.playedThisTurn[socket.id]=0;
    g.turn=ids[(ids.indexOf(socket.id)+1)%ids.length];
    emitState(room);
  });

  socket.on("disconnect",()=>{
    for(const r in games){
      if(games[r].players[socket.id]){
        delete games[r].players[socket.id];
        delete games[r].playedThisTurn[socket.id];
        if(!Object.keys(games[r].players).length) delete games[r];
        else emitState(r);
      }
    }
  });
});

server.listen(PORT,()=>console.log("Server läuft",PORT));
