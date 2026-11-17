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
const POWER_TXT = {
  Q: 'ver uma das suas cartas',
  J: 'trocar uma carta com outro jogador sem ver nenhuma',
  K: 'ver uma carta de outro jogador e decidir se a troca',
};

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

// ---------- Registo + efeitos visuais ----------
// Cada evento entra no registo e gera um "fx" que os clientes usam para animar cartas e mostrar avisos.
function event(room, kind, text, cells, actor) {
  room.fxId++;
  room.fx = { id: room.fxId, kind, text, cells: cells || [], actor: actor === undefined ? null : actor };
  room.log.push({ kind, text });
  if (room.log.length > 60) room.log.shift();
}

// ---------- Lógica do jogo ----------
function drawFromDeck(room) {
  if (room.deck.length === 0) {
    if (room.discard.length <= 1) return null;
    const top = room.discard.pop();
    room.deck = shuffle(room.discard);
    room.discard = [top];
    room.log.push({ kind: 'info', text: 'O baralho acabou — a pilha da mesa foi baralhada.' });
  }
  return room.deck.pop();
}

const cardsLeft = (p) => p.hand.filter(Boolean).length;
const connectedCount = (room) => room.players.filter((p) => p.connected).length;
const pname = (room, i) => room.players[i].name;

function startRound(room) {
  room.players = room.players.filter((p) => p.connected);
  room.deck = newDeck();
  room.discard = [];
  room.drawn = null;
  room.pending = null;
  room.snapOpen = false;
  room.covers = 0;
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
  event(room, 'start', `Ronda ${room.round} — cada jogador escolhe 2 cartas para memorizar.`);
}

function eligible(room, i) {
  const p = room.players[i];
  return p && p.connected && i !== room.gringoBy;
}

function advance(room) {
  const n = room.players.length;
  room.drawn = null;
  room.pending = null;
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
  if (room.phase === 'play') event(room, 'turn', `O jogo começou! Começa ${pname(room, room.turn)}.`);
}

function finishTurn(room) {
  const idx = room.turn;
  room.drawn = null;
  room.pending = null;
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
  if (auto && room.options.autoImmediate) {
    event(room, 'auto', `${pname(room, idx)} ficou sem cartas: AUTOGRINGO! Contam-se os pontos.`, [], idx);
    return endRound(room);
  }
  event(room, auto ? 'auto' : 'gringo', auto
    ? `${pname(room, idx)} ficou sem cartas: AUTOGRINGO! Os outros jogam mais uma vez.`
    : `${pname(room, idx)} disse GRINGO! As cartas dele ficam bloqueadas. Os outros jogam mais uma vez.`, [], idx);
  if (room.finalTurnsLeft <= 0) endRound(room);
}

function endRound(room) {
  room.phase = 'end';
  room.drawn = null;
  room.pending = null;
  room.snapOpen = false;
  const scores = room.players.map((p) => p.hand.filter(Boolean).reduce((s, c) => s + cardValue(c), 0));
  const min = Math.min(...scores);
  const winners = [];
  scores.forEach((s, i) => { if (s === min) winners.push(i); });
  room.players.forEach((p, i) => { p.total += scores[i]; });
  room.results = { scores, winners };
  event(room, 'end', `Fim da ronda! Ganhou ${winners.map((i) => pname(room, i)).join(' e ')} com ${min} pontos.`);
}

// Penalização: o jogador apanha uma carta do baralho sem a ver
function penalize(room, idx) {
  const p = room.players[idx];
  const pen = drawFromDeck(room);
  if (!pen) return null;
  const empty = p.hand.indexOf(null);
  const s = empty >= 0 ? empty : p.hand.length;
  p.hand[s] = pen;
  return { p: idx, s };
}

// Já alguém cobriu a carta da mesa e só se pode cobrir uma vez?
const coverClosed = (room) => !room.options.multiCover && room.covers >= 1;

// Cartas de outros jogadores que se podem escolher com o Valete ou o Rei
function validTarget(room, idx, tp, ts) {
  if (!Number.isInteger(tp) || !Number.isInteger(ts)) return false;
  if (tp === idx || tp === room.gringoBy) return false;
  const t = room.players[tp];
  return !!(t && ts >= 0 && ts < t.hand.length && t.hand[ts]);
}
function hasTargets(room, idx) {
  return room.players.some((p, i) => i !== idx && i !== room.gringoBy && cardsLeft(p) > 0);
}

// Depois de a carta tirada ir para a mesa: se for Q, J ou K o jogador ganha o poder
function afterDrawnPlayed(room, idx, card) {
  if (room.phase !== 'play') return;
  if (['Q', 'J', 'K'].includes(card.rank)) {
    const me = room.players[idx];
    const possible =
      (card.rank === 'Q' && cardsLeft(me) > 0) ||
      (card.rank === 'J' && cardsLeft(me) > 0 && hasTargets(room, idx)) ||
      (card.rank === 'K' && hasTargets(room, idx));
    if (possible) {
      room.pending = { type: card.rank, player: idx, stage: 'pick', target: null, reveal: [] };
      event(room, 'power', `${pname(room, idx)} jogou ${cardText(card)} e pode ${POWER_TXT[card.rank]}.`, [], idx);
      return;
    }
  }
  finishTurn(room);
}

// ---------- Vista personalizada de cada jogador ----------
function view(room, me) {
  const reveal = room.phase === 'end';
  const meP = room.players[me];
  const pend = room.pending;
  const isRevealed = (i, s) => !!(pend && pend.reveal.some((r) => r.p === i && r.s === s));
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
    covers: room.covers,
    options: room.options,
    deckCount: room.deck.length,
    discardTop: room.discard.length ? room.discard[room.discard.length - 1] : null,
    discardCount: room.discard.length,
    drawn: room.drawn ? (room.turn === me ? room.drawn : { hidden: true }) : null,
    pending: pend ? { type: pend.type, player: pend.player, stage: pend.stage, target: pend.target } : null,
    fx: room.fx,
    players: room.players.map((p, i) => ({
      name: p.name,
      connected: p.connected,
      total: p.total,
      ready: p.ready,
      isHost: p.token === room.hostToken,
      hand: p.hand.map((c, s) => {
        if (c === null) return null;
        const peeking = isRevealed(i, s);
        const show = reveal ||
          (i === me && room.phase === 'peek' && !p.ready && p.peekIdx.includes(s)) ||
          (peeking && pend.player === me);
        return show
          ? { rank: c.rank, suit: c.suit, value: cardValue(c), peeking }
          : { hidden: true, peeking };
      }),
    })),
    results: room.results,
    log: room.log.slice(-30),
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
    data = data || {};
    const name = String(data.name || '').trim().slice(0, 16);
    if (!name) return cb({ error: 'Escreve o teu nome.' });
    let code = String(data.code || '').trim().toUpperCase();
    let room;
    if (!code) {
      code = makeCode();
      room = {
        code, players: [], hostToken: null, phase: 'lobby', deck: [], discard: [], log: [],
        round: 0, dealer: -1, turn: 0, drawn: null, pending: null, snapOpen: false, gringoBy: null,
        autogringo: false, finalTurnsLeft: 0, results: null, fxId: 0, fx: null, covers: 0,
        // multiCover: pode-se cobrir a mesma carta mais do que uma vez
        // autoImmediate: quem fica sem cartas acaba logo a ronda (senão os outros jogam mais uma vez)
        options: { multiCover: false, autoImmediate: false },
      };
      rooms.set(code, room);
    } else {
      room = rooms.get(code);
      if (!room) return cb({ error: 'Essa sala não existe. Confirma o código.' });
    }

    let p = data.token && room.players.find((x) => x.token === data.token);
    if (p) {
      p.socketId = socket.id;
      if (!p.connected) event(room, 'join', `${p.name} voltou a ligar-se.`);
      p.connected = true;
    } else {
      if (room.phase !== 'lobby') return cb({ error: 'O jogo já começou nesta sala.' });
      if (room.players.length >= MAX_PLAYERS) return cb({ error: 'Sala cheia (máximo 6 jogadores).' });
      p = {
        token: crypto.randomUUID(), socketId: socket.id, name, connected: true,
        hand: [], peekIdx: [], ready: false, total: 0,
      };
      room.players.push(p);
      if (!room.hostToken) room.hostToken = p.token;
      event(room, 'join', `${p.name} entrou na sala.`);
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
    const err = (m) => socket.emit('toast', { kind: 'error', text: m });
    const isHost = p.token === room.hostToken;
    const myTurn = room.phase === 'play' && room.turn === idx;
    const pend = room.pending;
    const myPower = (type) => pend && pend.player === idx && pend.type === type;
    const validSlot = (s) => Number.isInteger(s) && s >= 0 && s < p.hand.length && p.hand[s] !== null;

    switch (a.type) {
      case 'start':
      case 'newRound': {
        if (!isHost) return err('Só o anfitrião pode começar.');
        if (room.phase !== 'lobby' && room.phase !== 'end') return;
        if (connectedCount(room) < MIN_PLAYERS) return err('São precisos pelo menos 2 jogadores.');
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
        if (room.phase !== 'peek' || p.peekIdx.length !== 2 || p.ready) return;
        p.ready = true;
        if (room.players.every((x) => !x.connected || x.ready)) startPlay(room);
        break;
      }
      case 'draw': {
        if (!myTurn) return err('Não é a tua vez.');
        if (room.drawn || pend) return;
        const c = drawFromDeck(room);
        if (!c) { endRound(room); break; }
        room.drawn = c;
        event(room, 'draw', `${p.name} tirou uma carta do baralho.`, [], idx);
        break;
      }
      case 'swap': {
        if (!myTurn || !room.drawn || pend) return;
        if (!validSlot(a.slot)) return;
        const old = p.hand[a.slot];
        p.hand[a.slot] = room.drawn;
        room.discard.push(old);
        room.snapOpen = true;
        room.covers = 0;
        event(room, 'swap', `${p.name} trocou uma carta e jogou ${cardText(old)}.`, [{ p: idx, s: a.slot }], idx);
        finishTurn(room);
        break;
      }
      case 'discard': {
        if (!myTurn || !room.drawn || pend) return;
        const c = room.drawn;
        room.drawn = null;
        room.discard.push(c);
        room.snapOpen = true;
        room.covers = 0;
        event(room, 'discard', `${p.name} jogou ${cardText(c)} na mesa.`, [], idx);
        afterDrawnPlayed(room, idx, c);
        break;
      }
      case 'double': {
        // Jogar a carta tirada junto com uma carta igual da mão (uma cobre a outra)
        if (!myTurn || !room.drawn || pend) return;
        if (!validSlot(a.slot)) return;
        const c = room.drawn;
        const mine = p.hand[a.slot];
        room.drawn = null;
        room.snapOpen = true;
        if (mine.rank === c.rank) {
          p.hand[a.slot] = null;
          room.discard.push(c, mine);
          room.covers = 1; // já houve uma carta a cobrir
          event(room, 'double', `${p.name} jogou um par: ${cardText(c)} + ${cardText(mine)}!`, [{ p: idx, s: a.slot }], idx);
          if (cardsLeft(p) === 0 && room.gringoBy === null) declareGringo(room, idx, true);
          afterDrawnPlayed(room, idx, c);
        } else {
          room.discard.push(c);
          room.covers = 0;
          const cell = penalize(room, idx);
          event(room, 'fail', `${p.name} tentou fazer par mas enganou-se (${cardText(mine)} ≠ ${c.rank}). Apanha uma carta sem ver.`,
            [{ p: idx, s: a.slot }].concat(cell ? [cell] : []), idx);
          finishTurn(room);
        }
        break;
      }
      case 'gringo': {
        if (!myTurn || room.drawn || pend) return;
        if (room.gringoBy !== null) return err('Já alguém disse Gringo.');
        declareGringo(room, idx, false);
        if (room.phase === 'play') advance(room);
        break;
      }
      case 'snap': {
        // Cobrir a carta da mesa com uma carta igual da própria mão
        if (room.phase !== 'play') return;
        if (idx === room.gringoBy) return err('Disseste Gringo: as tuas cartas estão bloqueadas.');
        if (!room.snapOpen || !room.discard.length) return err('Ainda não há carta na mesa para cobrir.');
        if (!validSlot(a.slot)) return;
        const top = room.discard[room.discard.length - 1];
        const c = p.hand[a.slot];
        if (c.rank !== top.rank) {
          const cell = penalize(room, idx);
          event(room, 'fail', `${p.name} enganou-se (mostrou ${cardText(c)}, não é ${top.rank}) e apanha uma carta sem ver.`,
            [{ p: idx, s: a.slot }].concat(cell ? [cell] : []), idx);
        } else if (coverClosed(room)) {
          const cell = penalize(room, idx);
          event(room, 'fail', `${p.name} chegou tarde: o ${top.rank} já tinha sido coberto. Fica com o ${cardText(c)} e apanha uma carta sem ver.`,
            [{ p: idx, s: a.slot }].concat(cell ? [cell] : []), idx);
        } else {
          room.discard.push(c);
          p.hand[a.slot] = null;
          room.covers++;
          event(room, 'snap', `${p.name} cobriu com ${cardText(c)}!`, [], idx);
          if (cardsLeft(p) === 0 && room.gringoBy === null) declareGringo(room, idx, true);
        }
        break;
      }
      case 'snapOther': {
        // Cobrir a carta da mesa com uma carta igual de OUTRO jogador e dar-lhe uma carta nossa
        if (room.phase !== 'play') return;
        if (idx === room.gringoBy) return err('Disseste Gringo: as tuas cartas estão bloqueadas.');
        if (!room.snapOpen || !room.discard.length) return err('Ainda não há carta na mesa para cobrir.');
        if (!validTarget(room, idx, a.tp, a.ts)) return err('Não podes usar essa carta.');
        const hasCards = cardsLeft(p) > 0;
        if (hasCards && !validSlot(a.slot)) return err('Escolhe a carta tua que lhe vais dar.');
        const t = room.players[a.tp];
        const top = room.discard[room.discard.length - 1];
        const c = t.hand[a.ts];
        if (c.rank !== top.rank) {
          const cell = penalize(room, idx);
          event(room, 'fail', `${p.name} tentou cobrir com uma carta de ${t.name}, mas era ${cardText(c)}. Apanha uma carta sem ver.`,
            [{ p: a.tp, s: a.ts }].concat(cell ? [cell] : []), idx);
        } else if (coverClosed(room)) {
          const cell = penalize(room, idx);
          event(room, 'fail', `${p.name} chegou tarde: o ${top.rank} já tinha sido coberto. Apanha uma carta sem ver.`,
            [{ p: a.tp, s: a.ts }].concat(cell ? [cell] : []), idx);
        } else {
          room.discard.push(c);
          room.covers++;
          if (hasCards) {
            t.hand[a.ts] = p.hand[a.slot];
            p.hand[a.slot] = null;
          } else {
            t.hand[a.ts] = null;
          }
          event(room, 'steal', `${p.name} cobriu com o ${cardText(c)} de ${t.name}` +
            (hasCards ? ' e deu-lhe uma carta sua!' : '!'), [{ p: a.tp, s: a.ts }], idx);
          if (cardsLeft(p) === 0 && room.gringoBy === null) declareGringo(room, idx, true);
          else if (cardsLeft(t) === 0 && room.gringoBy === null) declareGringo(room, a.tp, true);
        }
        break;
      }
      case 'setOption': {
        if (!isHost || (room.phase !== 'lobby' && room.phase !== 'end')) return;
        if (!['multiCover', 'autoImmediate'].includes(a.key)) return;
        room.options[a.key] = !!a.value;
        const txt = {
          multiCover: room.options.multiCover ? 'pode-se cobrir a mesma carta várias vezes' : 'só se pode cobrir uma vez (quem chega tarde é penalizado)',
          autoImmediate: room.options.autoImmediate ? 'quem fica sem cartas acaba logo a ronda' : 'quando alguém fica sem cartas, os outros jogam mais uma vez',
        }[a.key];
        event(room, 'info', `Regra alterada: ${txt}.`, [], idx);
        break;
      }

      // ----- Poderes das figuras -----
      case 'qPeek': {
        if (!myPower('Q') || pend.stage !== 'pick' || !validSlot(a.slot)) return;
        pend.stage = 'seen';
        pend.reveal = [{ p: idx, s: a.slot }];
        event(room, 'peek', `${p.name} está a ver uma das suas cartas.`, [{ p: idx, s: a.slot }], idx);
        break;
      }
      case 'jSwap': {
        if (!myPower('J') || !validSlot(a.slot)) return;
        if (!validTarget(room, idx, a.tp, a.ts)) return err('Escolhe uma carta de outro jogador.');
        const t = room.players[a.tp];
        [p.hand[a.slot], t.hand[a.ts]] = [t.hand[a.ts], p.hand[a.slot]];
        event(room, 'jswap', `${p.name} trocou uma carta com ${t.name} (ninguém viu).`,
          [{ p: idx, s: a.slot }, { p: a.tp, s: a.ts }], idx);
        finishTurn(room);
        break;
      }
      case 'kPeek': {
        if (!myPower('K') || pend.stage !== 'pick') return;
        if (!validTarget(room, idx, a.tp, a.ts)) return err('Escolhe uma carta de outro jogador.');
        pend.stage = 'decide';
        pend.target = { p: a.tp, s: a.ts };
        pend.reveal = [{ p: a.tp, s: a.ts }];
        event(room, 'peek', `${p.name} está a ver uma carta de ${pname(room, a.tp)}.`, [{ p: a.tp, s: a.ts }], idx);
        break;
      }
      case 'kSwap': {
        if (!myPower('K') || pend.stage !== 'decide' || !validSlot(a.slot)) return;
        const tg = pend.target;
        if (!validTarget(room, idx, tg.p, tg.s)) {
          pend.stage = 'pick'; pend.target = null; pend.reveal = [];
          err('Essa carta já não está disponível. Escolhe outra.');
          break;
        }
        const t = room.players[tg.p];
        [p.hand[a.slot], t.hand[tg.s]] = [t.hand[tg.s], p.hand[a.slot]];
        event(room, 'kswap', `${p.name} viu a carta de ${t.name} e decidiu trocar!`,
          [{ p: idx, s: a.slot }, { p: tg.p, s: tg.s }], idx);
        finishTurn(room);
        break;
      }
      case 'powerDone': {
        if (!pend || pend.player !== idx) return;
        if (pend.type === 'K' && pend.stage === 'decide') event(room, 'info', `${p.name} viu a carta e decidiu não trocar.`, [], idx);
        else if (pend.stage === 'pick') event(room, 'info', `${p.name} não usou o poder.`, [], idx);
        finishTurn(room);
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
      event(room, 'leave', `${p.name} saiu da sala.`);
    } else {
      p.connected = false;
      event(room, 'leave', `${p.name} desligou-se.`);
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
