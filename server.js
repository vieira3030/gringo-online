'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;
const rooms = new Map();

// ---------- Cartas ----------
const SUITS = ['♥', '♦', '♠', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function cardValue(c) {
  if (c.rank === 'A') return 1;
  if (c.rank === 'K') return (c.suit === '♥' || c.suit === '♦') ? -3 : 10;
  if (c.rank === 'J' || c.rank === 'Q') return 10;
  return parseInt(c.rank, 10);
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function newDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ rank: r, suit: s });
  return shuffle(d);
}
const cardText = (c) => c.rank + c.suit;

function makeCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += L[Math.floor(Math.random() * L.length)];
  } while (rooms.has(c));
  return c;
}

// ---------- Lógica do jogo ----------
function addLog(room, msg) {
  room.log.push(msg);
  if (room.log.length > 40) room.log.shift();
}

function drawFromDeck(room) {
  if (room.deck.length === 0) {
    if (room.discard.length <= 1) return null;
    const top = room.discard.pop();
    room.deck = shuffle(room.discard);
    room.discard = [top];
    addLog(room, '🔄 O baralho acabou — a pilha de descarte foi baralhada.');
  }
  return room.deck.pop();
}

const cardsLeft = (p) => p.hand.filter(Boolean).length;
const connectedCount = (room) => room.players.filter((p) => p.connected).length;

function startRound(room) {
  room.players = room.players.filter((p) => p.connected);
  room.deck = newDeck();
  room.discard = [];
  room.drawn = null;
  room.snapOpen = false;
  room.gringoBy = null;
  room.autogringo = false;
  room.finalTurnsLeft = 0;
  room.results = null;
  for (const p of room.players) {
    p.hand = [room.deck.pop(), room.deck.pop(), room.deck.pop(), room.deck.pop()];
    p.peekIdx = [];
    p.ready = false;
  }
  room.dealer = (room.dealer + 1) % room.players.length;
  room.turn = room.dealer;
  room.phase = 'peek';
  room.round++;
  addLog(room, `🃏 Ronda ${room.round}: cada um escolhe 2 cartas para ver e memorizar.`);
}

function eligible(room, i) {
  const p = room.players[i];
  return p && p.connected && i !== room.gringoBy;
}

function advance(room) {
  const n = room.players.length;
  room.drawn = null;
  for (let k = 1; k <= n; k++) {
    const i = (room.turn + k) % n;
    if (eligible(room, i)) {
      room.turn = i;
      return;
    }
  }
  endRound(room);
}

function startPlay(room) {
  room.phase = 'play';
  room.turn = room.dealer;
  advance(room);
  if (room.phase === 'play') addLog(room, `▶️ Começa ${room.players[room.turn].name}.`);
}

function finishTurn(room) {
  const idx = room.turn;
  room.drawn = null;
  if (room.gringoBy !== null && idx !== room.gringoBy) {
    room.finalTurnsLeft--;
    if (room.finalTurnsLeft <= 0) return endRound(room);
  }
  advance(room);
}

function declareGringo(room, idx, auto) {
  room.gringoBy = idx;
  room.autogringo = auto;
  room.finalTurnsLeft = room.players.filter((p, i) => i !== idx && p.connected).length;
  const name = room.players[idx].name;
  addLog(room, auto
    ? `🏁 ${name} ficou sem cartas: AUTOGRINGO! Os outros jogam mais uma vez.`
    : `📣 ${name} disse GRINGO! As cartas dele ficam bloqueadas. Os outros jogam mais uma vez.`);
  if (room.finalTurnsLeft <= 0) endRound(room);
}

function endRound(room) {
  room.phase = 'end';
  room.drawn = null;
  room.snapOpen = false;
  const scores = room.players.map((p) => p.hand.filter(Boolean).reduce((s, c) => s + cardValue(c), 0));
  const min = Math.min(...scores);
  const winners = [];
  scores.forEach((s, i) => { if (s === min) winners.push(i); });
  room.players.forEach((p, i) => { p.total += scores[i]; });
  room.results = { scores, winners };
  addLog(room, `🏆 Fim da ronda! Vencedor: ${winners.map((i) => room.players[i].name).join(', ')} (${min} pontos).`);
}

// ---------- Vista personalizada de cada jogador ----------
function view(room, me) {
  const reveal = room.phase === 'end';
  const meP = room.players[me];
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    me,
    isHost: meP.token === room.hostToken,
    turn: room.turn,
    gringoBy: room.gringoBy,
    autogringo: room.autogringo,
    finalTurnsLeft: room.finalTurnsLeft,
    snapOpen: room.snapOpen,
    deckCount: room.deck.length,
    discardTop: room.discard.length ? room.discard[room.discard.length - 1] : null,
    drawn: room.drawn ? (room.turn === me ? room.drawn : { hidden: true }) : null,
    players: room.players.map((p, i) => ({
      name: p.name,
      connected: p.connected,
      total: p.total,
      ready: p.ready,
      isHost: p.token === room.hostToken,
      hand: p.hand.map((c, s) => {
        if (c === null) return null;
        const show = reveal || (i === me && room.phase === 'peek' && !p.ready && p.peekIdx.includes(s));
        return show ? { rank: c.rank, suit: c.suit, value: cardValue(c) } : { hidden: true };
      }),
    })),
    results: room.results,
    log: room.log.slice(-14),
  };
}

function broadcast(room) {
  room.players.forEach((p, i) => {
    if (p.connected) io.to(p.socketId).emit('state', view(room, i));
  });
}

// ---------- Ligações ----------
io.on('connection', (socket) => {
  socket.on('join', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const name = String((data && data.name) || '').trim().slice(0, 16);
    if (!name) return cb({ error: 'Escreve o teu nome.' });
    let code = String((data && data.code) || '').trim().toUpperCase();
    let room;
    if (!code) {
      code = makeCode();
      room = {
        code, players: [], hostToken: null, phase: 'lobby', deck: [], discard: [], log: [],
        round: 0, dealer: -1, turn: 0, drawn: null, snapOpen: false, gringoBy: null,
        autogringo: false, finalTurnsLeft: 0, results: null,
      };
      rooms.set(code, room);
    } else {
      room = rooms.get(code);
      if (!room) return cb({ error: 'Essa sala não existe.' });
    }

    let p = data.token && room.players.find((x) => x.token === data.token);
    if (p) {
      p.socketId = socket.id;
      p.connected = true;
      addLog(room, `🔌 ${p.name} voltou a ligar-se.`);
    } else {
      if (room.phase !== 'lobby') return cb({ error: 'O jogo já começou nesta sala.' });
      if (room.players.length >= MAX_PLAYERS) return cb({ error: 'Sala cheia (máximo 6 jogadores).' });
      p = {
        token: crypto.randomUUID(), socketId: socket.id, name, connected: true,
        hand: [], peekIdx: [], ready: false, total: 0,
      };
      room.players.push(p);
      if (!room.hostToken) room.hostToken = p.token;
      addLog(room, `👋 ${p.name} entrou na sala.`);
    }
    socket.data.code = code;
    socket.data.token = p.token;
    socket.join(code);
    cb({ ok: true, code, token: p.token });
    broadcast(room);
  });

  socket.on('action', (a) => {
    const room = rooms.get(socket.data.code);
    if (!room || !a) return;
    const idx = room.players.findIndex((p) => p.token === socket.data.token);
    if (idx < 0) return;
    const p = room.players[idx];
    const toast = (m) => socket.emit('toast', m);
    const isHost = p.token === room.hostToken;
    const myTurn = room.phase === 'play' && room.turn === idx;
    const validSlot = (s) => Number.isInteger(s) && s >= 0 && s < p.hand.length && p.hand[s] !== null;

    switch (a.type) {
      case 'start':
      case 'newRound': {
        if (!isHost) return toast('Só o anfitrião pode começar.');
        if (room.phase !== 'lobby' && room.phase !== 'end') return;
        if (connectedCount(room) < MIN_PLAYERS) return toast('São precisos pelo menos 2 jogadores.');
        startRound(room);
        break;
      }
      case 'peek': {
        if (room.phase !== 'peek' || p.ready || p.peekIdx.length === 2) return;
        const sel = Array.isArray(a.slots) ? a.slots : [];
        if (sel.length !== 2 || sel[0] === sel[1] || !sel.every((s) => Number.isInteger(s) && s >= 0 && s < 4)) return;
        p.peekIdx = sel;
        break;
      }
      case 'ready': {
        if (room.phase !== 'peek' || p.peekIdx.length !== 2) return;
        p.ready = true;
        if (room.players.every((x) => !x.connected || x.ready)) startPlay(room);
        break;
      }
      case 'draw': {
        if (!myTurn) return toast('Não é a tua vez.');
        if (room.drawn) return;
        const c = drawFromDeck(room);
        if (!c) { addLog(room, 'Não há mais cartas.'); endRound(room); break; }
        room.drawn = c;
        addLog(room, `${p.name} tirou uma carta do baralho.`);
        break;
      }
      case 'swap': {
        if (!myTurn || !room.drawn || !validSlot(a.slot)) return;
        const old = p.hand[a.slot];
        p.hand[a.slot] = room.drawn;
        room.discard.push(old);
        room.snapOpen = true;
        addLog(room, `${p.name} trocou uma carta e jogou ${cardText(old)}.`);
        finishTurn(room);
        break;
      }
      case 'discard': {
        if (!myTurn || !room.drawn) return;
        const c = room.drawn;
        room.discard.push(c);
        room.snapOpen = true;
        addLog(room, `${p.name} jogou a carta tirada: ${cardText(c)}.`);
        finishTurn(room);
        break;
      }
      case 'gringo': {
        if (!myTurn || room.drawn) return;
        if (room.gringoBy !== null) return toast('Já alguém disse Gringo.');
        declareGringo(room, idx, false);
        if (room.phase === 'play') advance(room);
        break;
      }
      case 'snap': {
        if (room.phase !== 'play') return;
        if (idx === room.gringoBy) return toast('Disseste Gringo: as tuas cartas estão bloqueadas.');
        if (!room.snapOpen || !room.discard.length) return toast('Já não dá para jogar carta igual agora.');
        if (!validSlot(a.slot)) return;
        const top = room.discard[room.discard.length - 1];
        const c = p.hand[a.slot];
        if (c.rank === top.rank) {
          room.discard.push(c);
          p.hand[a.slot] = null;
          room.snapOpen = false; // só passam duas cartas iguais por jogada
          addLog(room, `⚡ ${p.name} foi rápido e jogou ${cardText(c)}!`);
          if (cardsLeft(p) === 0 && room.gringoBy === null) declareGringo(room, idx, true);
        } else {
          const pen = drawFromDeck(room);
          if (pen) {
            const empty = p.hand.indexOf(null);
            if (empty >= 0) p.hand[empty] = pen; else p.hand.push(pen);
          }
          addLog(room, `❌ ${p.name} enganou-se (mostrou ${cardText(c)}, não é ${top.rank}) e apanha uma carta sem ver.`);
        }
        break;
      }
      default:
        return;
    }
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    const idx = room.players.findIndex((p) => p.token === socket.data.token);
    if (idx < 0) return;
    const p = room.players[idx];
    if (p.socketId !== socket.id) return; // já voltou noutra ligação

    if (room.phase === 'lobby') {
      room.players.splice(idx, 1);
      addLog(room, `${p.name} saiu.`);
    } else {
      p.connected = false;
      addLog(room, `⚠️ ${p.name} desligou-se.`);
      if (room.phase === 'peek' && room.players.every((x) => !x.connected || x.ready) && connectedCount(room) > 0) {
        startPlay(room);
      } else if (room.phase === 'play' && room.turn === idx) {
        if (room.drawn) { room.discard.push(room.drawn); room.snapOpen = true; }
        finishTurn(room);
      }
    }
    if (p.token === room.hostToken) {
      const next = room.players.find((x) => x.connected);
      room.hostToken = next ? next.token : null;
    }
    if (connectedCount(room) === 0) {
      setTimeout(() => {
        if (rooms.get(room.code) === room && connectedCount(room) === 0) rooms.delete(room.code);
      }, 10 * 60 * 1000);
    } else {
      broadcast(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Gringo online a correr em http://localhost:${PORT}`);
});
