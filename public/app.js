'use strict';
/* ============================================================
   Gringo Online — cliente
   ============================================================ */
const socket = io();
const $ = (id) => document.getElementById(id);

let S = null;          // estado atual vindo do servidor
let prevS = null;      // estado anterior (para detetar mudanças)
let joined = null;     // { code, name }
let peekSel = [];      // cartas escolhidas na fase de memorizar
let mode = null;       // null | 'double' | 'snap'  (depois de tirar carta)
let jSel = { mine: null, other: null }; // seleção do poder do Valete
let lastFxId = 0;
let lastPendingKey = '';
let resultsShownRound = 0;

const COLORS = ['#e8b64c', '#4aa8ff', '#3ddc84', '#ff8a8d', '#b892ff', '#ffa14a'];
const avatarColor = (i) => COLORS[i % COLORS.length];
const LOG_ICON = {
  join: '👋', leave: '🚪', start: '🃏', turn: '▶️', draw: '🂠', swap: '🔁', discard: '⬇️', double: '🃏',
  snap: '⚡', fail: '❌', gringo: '📣', auto: '🏁', power: '✨', peek: '👁', jswap: '🔀', kswap: '👑',
  end: '🏆', info: 'ℹ️',
};
const POWER_NAME = { Q: 'Dama', J: 'Valete', K: 'Rei' };

/* ---------------- Som (Web Audio, sem ficheiros) ---------------- */
const Sound = {
  ctx: null,
  on: localStorage.getItem('gringo_sound') !== '0',
  tone(freqs, { dur = 0.14, type = 'sine', gap = 0.09, vol = 0.12 } = {}) {
    if (!this.on) return;
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = this.ctx.currentTime;
      freqs.forEach((f, i) => {
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        const st = t0 + i * gap;
        o.type = type;
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, st);
        g.gain.exponentialRampToValueAtTime(vol, st + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, st + dur);
        o.connect(g).connect(this.ctx.destination);
        o.start(st);
        o.stop(st + dur + 0.03);
      });
    } catch (e) { /* sem som */ }
  },
  play(kind) {
    switch (kind) {
      case 'turn': return this.tone([660, 880], { gap: 0.12, dur: 0.2 });
      case 'card': return this.tone([320], { type: 'triangle', dur: 0.08, vol: 0.1 });
      case 'good': return this.tone([523, 659, 784], { gap: 0.07 });
      case 'bad': return this.tone([220, 165], { type: 'sawtooth', gap: 0.12, vol: 0.06, dur: 0.2 });
      case 'power': return this.tone([440, 554, 659, 880], { type: 'triangle', gap: 0.06 });
      case 'gringo': return this.tone([392, 523, 659, 784], { type: 'square', gap: 0.1, vol: 0.06, dur: 0.22 });
      case 'end': return this.tone([523, 659, 784, 1046], { gap: 0.12, dur: 0.3 });
      case 'click': return this.tone([700], { dur: 0.05, vol: 0.06 });
    }
  },
};
function renderSoundBtn() {
  $('soundBtn').textContent = Sound.on ? '🔊' : '🔇';
  $('soundBtn').title = Sound.on ? 'Desligar som' : 'Ligar som';
}
$('soundBtn').onclick = () => {
  Sound.on = !Sound.on;
  localStorage.setItem('gringo_sound', Sound.on ? '1' : '0');
  renderSoundBtn();
  Sound.play('click');
};
renderSoundBtn();

/* ---------------- Avisos (toasts) ---------------- */
function toast(text, kind = 'info', icon) {
  const icons = { success: '✅', error: '⚠️', power: '✨', gold: '🔔', info: 'ℹ️' };
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.innerHTML = `<span class="ti">${icon || icons[kind] || 'ℹ️'}</span><span>${esc(text)}</span>`;
  $('toasts').appendChild(t);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 3800);
}

/* ---------------- Janela (modal) ---------------- */
let modalKind = null;
function openModal(html, kind, closable = true) {
  $('modalBody').innerHTML = '';
  if (typeof html === 'string') $('modalBody').innerHTML = html;
  else $('modalBody').appendChild(html);
  $('modalClose').classList.toggle('hidden', !closable);
  $('modal').classList.remove('hidden');
  modalKind = kind;
}
function closeModal() { $('modal').classList.add('hidden'); modalKind = null; }
$('modalClose').onclick = closeModal;
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
document.querySelectorAll('[data-open-rules]').forEach((b) => {
  b.onclick = () => openModal($('rulesTpl').content.cloneNode(true), 'rules');
});

/* ---------------- Entrar na sala ---------------- */
const params = new URLSearchParams(location.search);
$('nameInput').value = localStorage.getItem('gringo_name') || '';
if (params.get('sala')) $('codeInput').value = params.get('sala').toUpperCase();

function join(code) {
  const name = $('nameInput').value.trim() || (joined && joined.name) || '';
  if (!name) { $('joinError').textContent = 'Escreve o teu nome primeiro.'; $('nameInput').focus(); return; }
  localStorage.setItem('gringo_name', name);
  const token = code ? sessionStorage.getItem('gringo_' + code) : null;
  socket.emit('join', { name, code, token }, (res) => {
    if (res.error) {
      $('joinError').textContent = res.error;
      if (joined) toast(res.error, 'error');
      return;
    }
    sessionStorage.setItem('gringo_' + res.code, res.token);
    joined = { code: res.code, name };
    history.replaceState(null, '', '?sala=' + res.code);
    $('landing').classList.add('hidden');
    $('app').classList.remove('hidden');
  });
}
$('createBtn').onclick = () => join('');
$('joinBtn').onclick = () => {
  const c = $('codeInput').value.trim().toUpperCase();
  if (c.length !== 4) { $('joinError').textContent = 'O código tem 4 letras.'; return; }
  join(c);
};
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
$('nameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ($('codeInput').value.trim() ? $('joinBtn') : $('createBtn')).click();
});

function roomLink() { return location.origin + '/?sala=' + (joined ? joined.code : ''); }
function copyLink() {
  const url = roomLink();
  navigator.clipboard.writeText(url).then(
    () => toast('Link copiado! Envia-o aos teus amigos.', 'success', '🔗'),
    () => toast(url, 'info', '🔗'));
}
$('copyBtn').onclick = copyLink;

/* ---------------- Ligação ---------------- */
socket.on('connect', () => {
  $('conn').className = 'conn ok';
  $('conn').querySelector('span').textContent = 'Ligado';
  if (joined) join(joined.code);
});
socket.on('disconnect', () => {
  $('conn').className = 'conn bad';
  $('conn').querySelector('span').textContent = 'A religar…';
  toast('Ligação perdida. A tentar voltar a ligar…', 'error', '📡');
});
socket.on('toast', (t) => { toast(t.text, t.kind || 'info'); if (t.kind === 'error') Sound.play('bad'); });
socket.on('state', (s) => {
  prevS = S;
  S = s;
  onStateChange();
  render();
  applyFx();
});

const act = (type, extra = {}) => { Sound.play('click'); socket.emit('action', { type, ...extra }); };

/* ---------------- Ajudantes ---------------- */
function esc(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function el(tag, cls, html) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (html !== undefined) d.innerHTML = html;
  return d;
}
function btn(label, onClick, cls = 'secondary', disabled = false) {
  const b = el('button', 'btn ' + cls, label);
  b.onclick = onClick;
  b.disabled = disabled;
  return b;
}
function avatar(i, name) {
  const a = el('div', 'avatar', esc((name || '?')[0].toUpperCase()));
  a.style.background = avatarColor(i);
  return a;
}
const isRed = (c) => c.suit === '♥' || c.suit === '♦';
const myTurn = () => S && S.phase === 'play' && S.turn === S.me;
const myPending = () => S && S.pending && S.pending.player === S.me;
const visibleCount = (hand) => hand.filter((c) => c && !c.hidden).length;

function cardEl(c, size = '', p, s) {
  const d = el('div', 'card ' + size);
  if (p !== undefined) { d.dataset.p = p; d.dataset.s = s; }
  if (!c) { d.classList.add('empty'); return d; }
  if (c.hidden) {
    d.classList.add('back');
  } else {
    if (isRed(c)) d.classList.add('red');
    const center = ['J', 'Q', 'K'].includes(c.rank)
      ? `<div class="face">${c.rank}</div>`
      : `<div class="pip">${c.suit}</div>`;
    d.innerHTML =
      `<div class="corner tl"><span class="cr">${c.rank}</span><span class="cs">${c.suit}</span></div>${center}` +
      `<div class="corner br"><span class="cr">${c.rank}</span><span class="cs">${c.suit}</span></div>`;
    if (S && S.phase === 'end' && c.value !== undefined) {
      d.appendChild(el('div', 'val' + (c.value < 0 ? ' neg' : ''), c.value));
    }
  }
  if (c.peeking) {
    d.classList.add('peeking');
    d.appendChild(el('div', 'eye', '👁 a ver'));
  }
  return d;
}

/* ---------------- Reações a mudanças de estado ---------------- */
function onStateChange() {
  const s = S;
  const pKey = s.pending ? `${s.pending.type}${s.pending.player}${s.pending.stage}` : '';
  if (pKey !== lastPendingKey) { jSel = { mine: null, other: null }; lastPendingKey = pKey; }
  if (!(myTurn() && s.drawn && !s.pending)) mode = null;
  if (mode === 'snap' && !s.snapOpen) mode = null;
  if (s.phase !== 'peek') peekSel = [];

  const wasMyTurn = prevS && prevS.phase === 'play' && prevS.turn === prevS.me;
  if (myTurn() && !wasMyTurn) {
    Sound.play('turn');
    toast('É a tua vez de jogar!', 'gold', '🟢');
  }
  document.title = myTurn() ? '🟢 A tua vez — Gringo' : (s.phase === 'end' ? '🏆 Fim da ronda — Gringo' : 'Gringo Online');

  if (s.phase === 'end' && resultsShownRound !== s.round) {
    resultsShownRound = s.round;
    setTimeout(showResults, 900);
  }
  if (s.phase !== 'end' && modalKind === 'results') closeModal();
  if (modalKind === 'gringo' && !(myTurn() && !s.drawn && !s.pending)) closeModal();
}

/* Animações e avisos para cada evento do servidor */
function applyFx() {
  const fx = S.fx;
  if (!fx || fx.id === lastFxId) return;
  const first = lastFxId === 0;
  lastFxId = fx.id;
  if (first) return;

  const mine = fx.actor === S.me;
  const cellEls = (fx.cells || []).map((c) => document.querySelector(`.card[data-p="${c.p}"][data-s="${c.s}"]`)).filter(Boolean);
  const anim = (cls, els) => els.forEach((e) => { e.classList.remove(cls); void e.offsetWidth; e.classList.add(cls); });
  const discard = document.querySelector('#discard .card');
  const involvesMe = (fx.cells || []).some((c) => c.p === S.me);

  if (fx.actor !== null && fx.actor !== S.me) {
    const seat = document.querySelector(`.seat[data-p="${fx.actor}"]`);
    if (seat) anim('fx-seat', [seat]);
  }

  switch (fx.kind) {
    case 'draw':
      Sound.play('card');
      break;
    case 'swap':
    case 'discard':
      Sound.play('card');
      if (discard) anim('fx-land', [discard]);
      anim('fx-swap', cellEls);
      break;
    case 'snap':
    case 'double':
      Sound.play('good');
      if (discard) { anim('fx-land', [discard]); setTimeout(() => anim('fx-good', [discard]), 50); }
      toast(fx.text, 'success', fx.kind === 'snap' ? '⚡' : '🃏');
      break;
    case 'fail':
      Sound.play('bad');
      anim('fx-bad', cellEls);
      toast(fx.text, 'error', '❌');
      break;
    case 'power':
      Sound.play('power');
      if (discard) anim('fx-land', [discard]);
      if (!mine) toast(fx.text, 'power', '✨');
      break;
    case 'peek':
      Sound.play('power');
      anim('fx-flip', cellEls);
      anim('fx-power', cellEls);
      if (!mine && involvesMe) toast(fx.text.replace('uma carta de ' + S.players[S.me].name, 'uma carta TUA'), 'power', '👁');
      break;
    case 'jswap':
    case 'kswap':
      Sound.play('power');
      anim('fx-swap', cellEls);
      if (!mine && involvesMe) toast(`${S.players[fx.actor].name} trocou uma carta contigo!`, 'power', '🔀');
      else if (!mine) toast(fx.text, 'power', fx.kind === 'kswap' ? '👑' : '🔀');
      break;
    case 'gringo':
    case 'auto':
      Sound.play('gringo');
      toast(fx.text, 'error', '📣');
      break;
    case 'end':
      Sound.play('end');
      anim('fx-flip', [...document.querySelectorAll('.card:not(.empty)')]);
      break;
    case 'start':
      Sound.play('good');
      toast(fx.text, 'gold', '🃏');
      break;
    case 'turn':
      if (!myTurn()) toast(fx.text, 'info', '▶️');
      break;
    case 'join':
    case 'leave':
      Sound.play('click');
      if (!mine) toast(fx.text, 'info', LOG_ICON[fx.kind]);
      break;
    case 'info':
      if (!mine) toast(fx.text, 'info');
      break;
  }
}

/* ---------------- Desenhar ---------------- */
function render() {
  const s = S;
  $('roomCode').textContent = s.code;
  const phaseTxt = { lobby: 'Sala de espera', peek: 'A memorizar', play: 'Em jogo', end: 'Fim da ronda' }[s.phase];
  $('roundInfo').textContent = (s.round ? `Ronda ${s.round} · ` : '') + phaseTxt;

  const lobby = s.phase === 'lobby';
  $('lobbyPanel').classList.toggle('hidden', !lobby);
  $('piles').classList.toggle('hidden', lobby);
  $('opponents').classList.toggle('hidden', lobby);
  $('mySeat').classList.toggle('hidden', lobby);

  if (lobby) renderLobby(); else { renderOpponents(); renderPiles(); renderMySeat(); }
  renderPrompt();
  renderScores();
  renderLog();

  const gb = $('gringoBanner');
  if (s.phase === 'play' && s.gringoBy !== null) {
    gb.classList.remove('hidden');
    gb.textContent = `📣 ${s.players[s.gringoBy].name} disse ${s.autogringo ? 'AUTOGRINGO' : 'GRINGO'} · faltam ${s.finalTurnsLeft} jogada(s)`;
  } else gb.classList.add('hidden');
}

function renderLobby() {
  const s = S;
  const p = $('lobbyPanel');
  p.innerHTML = '';
  p.appendChild(el('h3', '', 'Sala de espera'));
  p.appendChild(el('p', '', `Partilha o código <b>${esc(s.code)}</b> ou o link com os teus amigos. Podem jogar de 2 a 6 pessoas.`));
  const share = el('div', 'share-row');
  const inp = el('input');
  inp.value = roomLink();
  inp.readOnly = true;
  inp.onclick = () => inp.select();
  share.appendChild(inp);
  share.appendChild(btn('Copiar', copyLink, 'secondary'));
  p.appendChild(share);
  const list = el('div', 'lobby-players');
  s.players.forEach((pl, i) => {
    const chip = el('div', 'lobby-player');
    chip.appendChild(avatar(i, pl.name));
    chip.appendChild(el('span', '', esc(pl.name) + (i === s.me ? ' (tu)' : '') + (pl.isHost ? ' 👑' : '')));
    list.appendChild(chip);
  });
  for (let k = s.players.length; k < 6; k++) list.appendChild(el('div', 'lobby-empty', 'lugar livre'));
  p.appendChild(list);
  if (s.isHost) {
    const b = btn(s.players.length < 2 ? 'À espera de mais jogadores…' : `Começar jogo (${s.players.length} jogadores)`,
      () => act('start'), 'primary lg', s.players.length < 2);
    p.appendChild(b);
  } else {
    p.appendChild(el('p', '', '⏳ À espera que o anfitrião comece o jogo…'));
  }
}

function renderOpponents() {
  const s = S;
  const box = $('opponents');
  box.innerHTML = '';
  const pend = s.pending;
  const targeting = myPending() && ((pend.type === 'J') || (pend.type === 'K' && pend.stage === 'pick'));

  s.players.forEach((p, i) => {
    if (i === s.me) return;
    const seat = el('div', 'seat');
    seat.dataset.p = i;
    const isTurn = s.phase === 'play' && s.turn === i;
    if (isTurn) seat.classList.add('turn');
    if (!p.connected) seat.classList.add('off');
    if (targeting && i !== s.gringoBy) seat.classList.add('target');

    const head = el('div', 'seat-head');
    head.appendChild(avatar(i, p.name));
    const cards = p.hand.filter(Boolean).length;
    head.appendChild(el('div', '', `<div class="seat-name">${esc(p.name)}</div><div class="seat-sub">${p.total} pts · ${cards} carta${cards === 1 ? '' : 's'}</div>`));
    head.appendChild(el('div', 'spacer'));
    const badges = el('div', 'badges');
    if (isTurn) badges.appendChild(el('span', 'badge green', 'a jogar <span class="thinking"><i></i><i></i><i></i></span>'));
    if (pend && pend.player === i) badges.appendChild(el('span', 'badge purple', 'poder ' + POWER_NAME[pend.type]));
    if (s.gringoBy === i) badges.appendChild(el('span', 'badge red', s.autogringo ? 'autogringo' : 'gringo'));
    if (s.phase === 'peek') badges.appendChild(el('span', 'badge ' + (p.ready ? 'green' : ''), p.ready ? 'pronto' : 'a memorizar'));
    if (p.isHost) badges.appendChild(el('span', 'badge gold', 'anfitrião'));
    if (!p.connected) badges.appendChild(el('span', 'badge red', 'desligado'));
    head.appendChild(badges);
    seat.appendChild(head);

    const hand = el('div', 'hand');
    p.hand.forEach((c, si) => {
      const ce = cardEl(c, '', i, si);
      if (c && s.gringoBy === i) ce.classList.add('locked');
      if (c && targeting && i !== s.gringoBy) {
        ce.classList.add('clickable', 'c-power');
        if (pend.type === 'J') {
          ce.title = 'Escolher esta carta para trocar';
          if (jSel.other && jSel.other.p === i && jSel.other.s === si) ce.classList.add('selected');
          ce.onclick = () => { Sound.play('click'); jSel.other = { p: i, s: si }; render(); };
        } else {
          ce.title = 'Ver esta carta';
          ce.onclick = () => act('kPeek', { tp: i, ts: si });
        }
      }
      hand.appendChild(ce);
    });
    seat.appendChild(hand);
    box.appendChild(seat);
  });
}

function renderPiles() {
  const s = S;
  // Baralho
  const deck = $('deck');
  deck.innerHTML = '';
  const stack = el('div', 'deck-stack');
  for (let k = 0; k < 3; k++) stack.appendChild(cardEl(s.deckCount ? { hidden: true } : null, 'lg'));
  if (myTurn() && !s.drawn && !s.pending) {
    stack.classList.add('clickable');
    stack.title = 'Tirar uma carta';
    stack.onclick = () => act('draw');
  }
  deck.appendChild(stack);
  $('deckCount').textContent = s.deckCount;

  // Mesa
  const dis = $('discard');
  dis.innerHTML = '';
  const top = s.discardTop ? cardEl(s.discardTop, 'lg') : el('div', 'card lg ghost');
  dis.appendChild(top);

  // Carta tirada
  const dp = $('drawnPile');
  dp.classList.toggle('hidden', !s.drawn);
  const dr = $('drawn');
  dr.innerHTML = '';
  if (s.drawn) {
    const c = cardEl(s.drawn, 'lg');
    if (myTurn()) c.classList.add('fx-flip');
    dr.appendChild(c);
    $('drawnLabel').textContent = myTurn() ? 'A tua carta' : `${s.players[s.turn].name} está a decidir`;
  }
}

function renderMySeat() {
  const s = S;
  const me = s.players[s.me];
  const locked = s.gringoBy === s.me;
  const pend = s.pending;
  $('mySeat').classList.toggle('turn', myTurn());

  const av = $('myAvatar');
  av.textContent = (me.name[0] || '?').toUpperCase();
  av.style.background = avatarColor(s.me);
  $('myName').textContent = me.name + ' (tu)';
  const n = me.hand.filter(Boolean).length;
  $('mySub').textContent = `${me.total} pts no total · ${n} carta${n === 1 ? '' : 's'}`;
  const badges = $('myBadges');
  badges.innerHTML = '';
  if (myTurn()) badges.appendChild(el('span', 'badge green', 'a tua vez'));
  if (myPending()) badges.appendChild(el('span', 'badge purple', 'poder ' + POWER_NAME[pend.type]));
  if (locked) badges.appendChild(el('span', 'badge red', 'cartas bloqueadas'));
  if (me.isHost) badges.appendChild(el('span', 'badge gold', 'anfitrião'));

  // Cartas
  const hand = $('myHand');
  hand.innerHTML = '';
  const canPeekPick = s.phase === 'peek' && !me.ready && visibleCount(me.hand) < 2;
  me.hand.forEach((c, i) => {
    const ce = cardEl(c, 'lg', s.me, i);
    if (!c) { hand.appendChild(ce); return; }
    if (locked) ce.classList.add('locked');
    const click = (cls, title, fn) => { ce.classList.add('clickable'); if (cls) ce.classList.add(cls); ce.title = title; ce.onclick = fn; };

    if (canPeekPick) {
      if (peekSel.includes(i)) ce.classList.add('selected');
      click('c-power', 'Ver esta carta', () => {
        Sound.play('click');
        if (peekSel.includes(i)) peekSel = peekSel.filter((x) => x !== i);
        else if (peekSel.length < 2) peekSel.push(i);
        if (peekSel.length === 2) socket.emit('action', { type: 'peek', slots: peekSel });
        render();
      });
    } else if (myPending()) {
      if (pend.type === 'Q' && pend.stage === 'pick') click('c-power', 'Ver esta carta', () => act('qPeek', { slot: i }));
      if (pend.type === 'J') {
        if (jSel.mine === i) ce.classList.add('selected');
        click('c-power', 'Escolher esta carta para trocar', () => { Sound.play('click'); jSel.mine = i; render(); });
      }
      if (pend.type === 'K' && pend.stage === 'decide') click('c-power', 'Dar esta carta em troca', () => act('kSwap', { slot: i }));
    } else if (s.phase === 'play' && !locked) {
      if (myTurn() && s.drawn) {
        if (mode === 'double') click('c-snap', 'Jogar par com esta carta', () => act('double', { slot: i }));
        else if (mode === 'snap') click('c-snap', 'Jogar esta carta igual', () => act('snap', { slot: i }));
        else click('', 'Trocar pela carta tirada', () => act('swap', { slot: i }));
      } else if (s.snapOpen && s.discardTop) {
        click('c-snap', `Jogar esta carta (se for ${s.discardTop.rank})`, () => act('snap', { slot: i }));
      }
    }
    hand.appendChild(ce);
  });

  // Botões
  const a = $('actions');
  a.innerHTML = '';
  if (s.phase === 'peek' && !me.ready && visibleCount(me.hand) === 2) {
    a.appendChild(btn('✓ Pronto, já memorizei', () => act('ready'), 'primary lg'));
  }
  if (s.phase === 'play') {
    if (myPending()) {
      if (pend.type === 'Q' && pend.stage === 'pick') a.appendChild(btn('Não usar o poder', () => act('powerDone')));
      if (pend.type === 'Q' && pend.stage === 'seen') a.appendChild(btn('✓ Feito, já memorizei', () => act('powerDone'), 'primary'));
      if (pend.type === 'J') {
        const ok = jSel.mine !== null && jSel.other !== null;
        a.appendChild(btn('🔀 Trocar as cartas', () => act('jSwap', { slot: jSel.mine, tp: jSel.other.p, ts: jSel.other.s }), 'purple', !ok));
        a.appendChild(btn('Não usar o poder', () => act('powerDone')));
      }
      if (pend.type === 'K' && pend.stage === 'pick') a.appendChild(btn('Não usar o poder', () => act('powerDone')));
      if (pend.type === 'K' && pend.stage === 'decide') a.appendChild(btn('Não trocar', () => act('powerDone')));
    } else if (myTurn() && !s.drawn) {
      a.appendChild(btn('🂠 Tirar carta', () => act('draw'), 'primary lg'));
      if (s.gringoBy === null) a.appendChild(btn('📣 Gringo!', confirmGringo, 'danger lg'));
    } else if (myTurn() && s.drawn) {
      const power = ['Q', 'J', 'K'].includes(s.drawn.rank);
      a.appendChild(btn(power ? `⬇️ Jogar na mesa e usar o poder (${POWER_NAME[s.drawn.rank]})` : '⬇️ Jogar na mesa',
        () => act('discard'), power ? 'purple' : 'secondary'));
      if (me.hand.some(Boolean)) {
        a.appendChild(btn(mode === 'double' ? '✕ Cancelar par' : `🃏 Fazer par de ${s.drawn.rank}`,
          () => { mode = mode === 'double' ? null : 'double'; Sound.play('click'); render(); }, mode === 'double' ? 'active' : 'secondary'));
      }
      if (s.snapOpen && s.discardTop && me.hand.some(Boolean)) {
        a.appendChild(btn(mode === 'snap' ? '✕ Cancelar' : `⚡ Carta igual à mesa (${s.discardTop.rank})`,
          () => { mode = mode === 'snap' ? null : 'snap'; Sound.play('click'); render(); }, mode === 'snap' ? 'active' : 'secondary'));
      }
    }
  }
  if (s.phase === 'end') {
    a.appendChild(btn('🏆 Ver resultados', showResults, 'secondary'));
    if (s.isHost) a.appendChild(btn('Próxima ronda ▶', () => act('newRound'), 'primary'));
  }
}

function renderPrompt() {
  const s = S;
  const pr = $('prompt');
  let icon = 'ℹ️', cls = '', html = '';
  const me = s.players[s.me];
  const pend = s.pending;
  const turnName = s.players[s.turn] ? esc(s.players[s.turn].name) : '';
  const snapHint = s.snapOpen && s.discardTop && s.gringoBy !== s.me
    ? `<span class="hint">⚡ Tens um <b>${s.discardTop.rank}</b>? Clica nele rápido para o jogar!</span>` : '';

  if (s.phase === 'lobby') {
    icon = '👥';
    html = `À espera de jogadores <b>(${s.players.length}/6)</b>.` + (s.isHost ? ' Quando estiverem todos, carrega em <b>Começar jogo</b>.' : ' O anfitrião vai começar o jogo.');
  } else if (s.phase === 'peek') {
    const seen = visibleCount(me.hand);
    if (me.ready) { icon = '⏳'; html = 'À espera que os outros memorizem as cartas…'; }
    else if (seen === 2) { icon = '🧠'; cls = 'warn'; html = '<b>Memoriza bem estas 2 cartas!</b> Quando estiveres pronto, carrega em <b>Pronto</b>.<span class="hint">Depois disso deixas de as ver.</span>'; }
    else { icon = '👀'; cls = 'turn'; html = `Escolhe <b>2 das tuas cartas</b> para veres (${peekSel.length}/2).`; }
  } else if (s.phase === 'play') {
    if (myPending()) {
      cls = 'power';
      if (pend.type === 'Q') {
        icon = '♛';
        html = pend.stage === 'pick'
          ? '<b>Poder da Dama:</b> clica numa das <b>tuas</b> cartas para a veres.'
          : '<b>Memoriza a carta</b> e carrega em <b>Feito</b>.';
      } else if (pend.type === 'J') {
        icon = '♞';
        const step = jSel.mine === null ? 'Escolhe primeiro uma carta <b>tua</b>.' : (jSel.other === null ? 'Agora escolhe uma carta de <b>outro jogador</b>.' : 'Carrega em <b>Trocar as cartas</b> para confirmar.');
        html = `<b>Poder do Valete:</b> trocas uma carta tua com uma de outro jogador, sem ninguém ver. <span class="hint">${step}</span>`;
      } else {
        icon = '♚';
        html = pend.stage === 'pick'
          ? '<b>Poder do Rei:</b> clica numa carta de <b>outro jogador</b> para a veres.'
          : `Estás a ver a carta de <b>${esc(s.players[pend.target.p].name)}</b>. Para ficares com ela, clica na carta <b>tua</b> que lhe queres dar. <span class="hint">Ou carrega em <b>Não trocar</b>.</span>`;
      }
    } else if (pend) {
      icon = '✨'; cls = 'power';
      html = `<b>${turnName}</b> está a usar o poder do <b>${POWER_NAME[pend.type]}</b>…` + snapHint;
    } else if (s.gringoBy === s.me) {
      icon = '🔒'; cls = 'alert';
      html = `Disseste <b>${s.autogringo ? 'Autogringo' : 'Gringo'}</b>! As tuas cartas estão bloqueadas. Faltam ${s.finalTurnsLeft} jogada(s) dos outros.`;
    } else if (myTurn() && !s.drawn) {
      icon = '🟢'; cls = 'turn';
      html = '<b>É a tua vez!</b> Tira uma carta do baralho' + (s.gringoBy === null ? ', ou diz <b>Gringo</b> se achas que tens menos pontos.' : '.') + snapHint;
    } else if (myTurn() && s.drawn) {
      icon = '🟢'; cls = 'turn';
      const r = s.drawn.rank;
      if (mode === 'double') {
        html = `<b>Fazer par:</b> clica na tua carta <b>${r}</b> para jogares as duas.<span class="hint">Se te enganares, a carta tirada vai para a mesa e apanhas uma carta sem ver.</span>`;
      } else if (mode === 'snap') {
        html = `Clica na tua carta igual à da mesa (<b>${s.discardTop.rank}</b>).`;
      } else {
        const power = ['Q', 'J', 'K'].includes(r)
          ? `<span class="hint">✨ Se jogares este ${POWER_NAME[r]} na mesa, ganhas o poder: ${{ Q: 'ver uma carta tua', J: 'trocar uma carta com outro jogador sem ver', K: 'ver uma carta de outro jogador e decidir se trocas' }[r]}.</span>`
          : '<span class="hint">Tens outra igual? Usa <b>Fazer par</b> para jogar as duas.</span>';
        html = `Tiraste <b>${r}${s.drawn.suit}</b>. Clica numa carta tua para a <b>trocar</b>, ou joga-a na mesa.` + power;
      }
    } else {
      icon = '⏳'; cls = s.snapOpen && s.discardTop && s.gringoBy !== s.me ? 'warn' : '';
      html = `Vez de <b>${turnName}</b>.` + snapHint;
    }
  } else if (s.phase === 'end') {
    icon = '🏆'; cls = 'warn';
    const w = s.results ? s.results.winners.map((i) => esc(s.players[i].name)).join(' e ') : '';
    html = `<b>Fim da ronda!</b> Ganhou ${w}. Todas as cartas estão à mostra.` + (s.isHost ? ' Carrega em <b>Próxima ronda</b> para continuar.' : ' À espera do anfitrião.');
  }
  pr.className = 'prompt ' + cls;
  pr.innerHTML = `<span class="p-ico">${icon}</span><div>${html}</div>`;
}

function renderScores() {
  const s = S;
  const order = s.players.map((p, i) => ({ p, i })).sort((a, b) => a.p.total - b.p.total);
  $('scoreList').innerHTML = '';
  order.forEach(({ p, i }, k) => {
    const row = el('div', 'score-row' + (i === s.me ? ' me' : '') + (s.phase === 'play' && s.turn === i ? ' turn' : ''));
    row.appendChild(el('span', 'pos', s.round ? k + 1 : '·'));
    row.appendChild(avatar(i, p.name));
    row.appendChild(el('span', 'nm', esc(p.name) + (i === s.me ? ' (tu)' : '') + (p.connected ? '' : ' · off')));
    row.appendChild(el('span', 'pts', p.total));
    $('scoreList').appendChild(row);
  });
}

function renderLog() {
  const log = $('log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = S.log.map((l) =>
    `<div class="log-item"><span class="li">${LOG_ICON[l.kind] || '•'}</span><span>${esc(l.text)}</span></div>`).join('');
  if (atBottom || !prevS) log.scrollTop = log.scrollHeight;
}

/* ---------------- Janelas específicas ---------------- */
function confirmGringo() {
  const box = el('div');
  box.appendChild(el('h2', '', '📣 Dizer Gringo?'));
  box.appendChild(el('p', 'confirm-text',
    'Se achas que tens menos pontos do que todos, diz Gringo. Nesta vez não jogas, as tuas cartas ficam bloqueadas, os outros jogam mais uma vez e depois mostram-se todas as cartas.'));
  const actions = el('div', 'modal-actions');
  actions.appendChild(btn('Cancelar', closeModal));
  actions.appendChild(btn('Sim, GRINGO!', () => { closeModal(); act('gringo'); }, 'danger'));
  box.appendChild(actions);
  openModal(box, 'gringo');
}

function showResults() {
  const s = S;
  if (!s || s.phase !== 'end' || !s.results) return;
  const box = el('div');
  const w = s.results.winners.map((i) => esc(s.players[i].name)).join(' e ');
  const iWon = s.results.winners.includes(s.me);
  box.appendChild(el('h2', '', iWon ? '🏆 Ganhaste a ronda!' : `🏆 Fim da ronda ${s.round}`));
  box.appendChild(el('p', 'lead', `Vencedor: <b>${w}</b> com ${Math.min(...s.results.scores)} pontos.`));
  const t = el('table', 'results-table');
  t.innerHTML = '<tr><th>Jogador</th><th>Cartas</th><th style="text-align:right">Ronda</th><th style="text-align:right">Total</th></tr>';
  s.players.map((p, i) => ({ p, i })).sort((a, b) => s.results.scores[a.i] - s.results.scores[b.i]).forEach(({ p, i }) => {
    const tr = el('tr', s.results.winners.includes(i) ? 'win' : '');
    tr.appendChild(el('td', '', (s.results.winners.includes(i) ? '🏆 ' : '') + esc(p.name) + (i === s.me ? ' (tu)' : '')));
    const td = el('td');
    const mini = el('div', 'mini');
    p.hand.filter(Boolean).forEach((c) => mini.appendChild(cardEl(c)));
    if (!mini.children.length) mini.textContent = '—';
    td.appendChild(mini);
    tr.appendChild(td);
    tr.appendChild(el('td', 'num', s.results.scores[i]));
    tr.appendChild(el('td', 'num', p.total));
    t.appendChild(tr);
  });
  box.appendChild(t);
  const actions = el('div', 'modal-actions');
  actions.appendChild(btn('Ver a mesa', closeModal));
  if (s.isHost) actions.appendChild(btn('Próxima ronda ▶', () => { closeModal(); act('newRound'); }, 'primary'));
  else actions.appendChild(el('span', 'muted', 'À espera do anfitrião…'));
  box.appendChild(actions);
  openModal(box, 'results');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (modalKind) closeModal();
    else if (mode) { mode = null; render(); }
  }
});
