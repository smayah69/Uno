// The page: home screen, lobby, game screen and chat. The game itself runs in
// a Host (host.js, when you host) or a Client (client.js, when you join);
// both call back into the UI below.
import { MAX_PLAYERS, MIN_PLAYERS, playerBySeat, gameTime, formatTime, awayPlayers } from './game.js';
import { TableView } from './table.js';
import {
  avatar, badge, scoreboard, seatColor, ruleChips, roundEndSound, resultsTitle, resultsSubtitle, RESULTS_DELAY,
} from './parts.js';
import { sound } from './sound.js';
import './analytics.js';
import { sanitizeName, sanitizeChat } from './text.js';
import { isLocalMode } from './net.js';
import { isRoom, codeLabel, roomFromPath, roomLink, savedTicket, login } from './room.js';
import { local, session } from './store.js';
import { RETRY_MS, CHAT_KEEP, validChat } from './protocol.js';
import { Host, TURN_MS as DEFAULT_TURN_MS } from './host.js';
import { Client } from './client.js';

// ?local=1&turnms=N shortens the turn timer for tests.
const TURN_MS = (isLocalMode && Number(new URLSearchParams(location.search).get('turnms'))) || DEFAULT_TURN_MS;

const $ = (sel) => document.querySelector(sel);

class UI {
  constructor() {
    this.session = null;
    this.state = null;
    this.me = null;
    this.clockOffset = 0; // host clock minus ours
    this.hostIsAway = false;
    this.chatLines = [];
    this.chatSeats = null; // seat layout the chat names were colored for
    this.unread = 0;
    this.endShown = false;
    this.room = roomFromPath();
    const send = (fn) => (...args) => this.session && this.session[fn](...args);
    this.table = new TableView({
      actions: {
        play: send('sendPlay'),
        draw: send('sendDraw'),
        pass: send('sendPass'),
        uno: send('sendUno'),
        catch: send('sendCatch'),
        replaceWithBot: (p) => {
          if (!(this.session instanceof Host)) return;
          if (confirm(`Replace ${p.name} with a bot for the rest of this game? They will be disconnected and can't take the seat back.`)) this.session.replaceWithBot(p.id);
        },
      },
      toast: (text) => this.toast(text),
      turnTotal: TURN_MS,
    });
    this.bind();
    this.autoResume();
  }

  bind() {
    const name = $('#name-input');
    const pin = $('#pin-input');
    name.value = local.get('uno.name') || '';
    const params = new URLSearchParams(location.search);
    const urlPin = params.get('pin') || session.get('uno.pin');
    if (!this.room && urlPin && /^\d{6}$/.test(urlPin)) { pin.value = urlPin; $('#join-box').hidden = false; }
    $('#local-badge').hidden = !isLocalMode;
    const password = $('#room-password');
    if (this.room) {
      document.title = `${codeLabel(this.room)} · Uno`;
      $('.tagline').textContent = `Private room ${codeLabel(this.room)}`;
      $('#home-actions').hidden = true;
      $('#room-box').hidden = false;
      $('#btn-room-join').textContent = `Join ${codeLabel(this.room)}`;
    }

    const refresh = () => {
      const ok = sanitizeName(name.value).length > 0;
      $('#btn-host').disabled = !ok;
      $('#btn-join-toggle').disabled = !ok;
      $('#btn-join').disabled = !ok || !/^\d{6}$/.test(pin.value);
      $('#btn-room-join').disabled = !ok;
      $('#btn-room-host').disabled = !ok;
      $('#btn-room-open').disabled = !ok || !password.value;
      if (this.room) $('#btn-room-host').textContent = savedTicket() ? `Open ${codeLabel(this.room)} (host)` : "I'm the host";
      const saved = Host.loadSaved();
      const show = saved && (!this.room || saved.pin === this.room);
      $('#resume-box').hidden = !show;
      if (show) $('#resume-pin').textContent = codeLabel(saved.pin);
    };
    this.refreshHome = refresh;
    name.addEventListener('input', refresh);
    password.addEventListener('input', refresh);
    pin.addEventListener('input', () => { pin.value = pin.value.replace(/\D/g, '').slice(0, 6); refresh(); });
    refresh();

    $('#btn-host').addEventListener('click', () => this.host());
    $('#btn-resume').addEventListener('click', () => this.host(Host.loadSaved()));
    $('#btn-discard').addEventListener('click', () => { Host.discardSaved(); refresh(); });
    $('#btn-join-toggle').addEventListener('click', () => { $('#join-box').hidden = false; pin.focus(); });
    $('#home-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!this.room) { if (!$('#btn-join').disabled) this.join(pin.value); }
      else if (document.activeElement === password) { if (!$('#btn-room-open').disabled) this.openRoom(); }
      else if (!$('#btn-room-join').disabled) this.join(this.room);
    });
    $('#btn-room-host').addEventListener('click', () => {
      if (savedTicket()) { this.host(null, this.room); return; }
      $('#room-login').hidden = false;
      password.focus();
    });
    $('#btn-room-open').addEventListener('click', () => this.openRoom());
    $('#btn-room-cancel').addEventListener('click', () => this.stopWaiting());

    // Lobby
    const hostOnly = (fn) => () => { if (this.session instanceof Host) fn(this.session); };
    $('#btn-copy-pin').addEventListener('click', () => this.copy(this.pin, 'PIN copied'));
    $('#btn-copy-link').addEventListener('click', () => this.copy(this.inviteLink(), 'Invite link copied'));
    $('#btn-invite').addEventListener('click', () => this.copy(this.inviteLink(), 'Invite link copied'));
    $('#btn-start').addEventListener('click', hostOnly((h) => h.begin()));
    $('#btn-add-bot').addEventListener('click', hostOnly((h) => h.addBot()));
    $('#btn-leave-lobby').addEventListener('click', () => this.leave());
    for (const input of document.querySelectorAll('#rules input')) {
      input.addEventListener('change', hostOnly((h) => h.setRule(input.dataset.rule, input.checked)));
    }

    // Game
    $('#btn-leave-game').addEventListener('click', () => {
      const msg = this.session instanceof Host
        ? 'End the game for everyone?\n\n(If you just close or refresh the tab instead, the game pauses and you can resume it.)'
        : 'Leave the game? It will pause until you come back.';
      if (confirm(msg)) this.leave();
    });
    $('#btn-back').addEventListener('click', () => this.session && this.session.sendBack());
    $('#btn-continue').addEventListener('click', hostOnly((h) => h.continueWithout()));
    $('#btn-again').addEventListener('click', hostOnly((h) => { $('#overlay').hidden = true; h.backToLobby(); }));
    $('#btn-home').addEventListener('click', () => this.leave());
    $('#btn-copy-results').addEventListener('click', () => this.copy(this.results, 'Results copied'));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.toggleChat(false); });

    setInterval(() => this.renderClock(), 1000);
    $('#btn-chat').addEventListener('click', () => this.toggleChat());
    $('#btn-chat-close').addEventListener('click', () => this.toggleChat(false));
    $('#chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#chat-input');
      const text = sanitizeChat(input.value);
      if (text && this.session) this.session.sendChat(text);
      input.value = '';
    });
    const soundBtn = $('#btn-sound');
    soundBtn.classList.toggle('muted', sound.muted);
    soundBtn.addEventListener('click', () => soundBtn.classList.toggle('muted', sound.toggle()));
  }

  // A refreshed tab goes straight back into the game it was in.
  autoResume() {
    const mode = session.get('uno.session');
    if (!sanitizeName($('#name-input').value)) return;
    const saved = Host.loadSaved();
    if (mode === 'host' && saved) this.host(saved);
    else if (mode === 'host' && this.room && savedTicket()) this.host(null, this.room);
    else if (mode === 'client' && this.room && session.get('uno.pin') === this.room) this.join(this.room);
    else if (mode === 'client' && /^\d{6}$/.test($('#pin-input').value)) this.join($('#pin-input').value);
  }

  myName() {
    const n = sanitizeName($('#name-input').value);
    local.set('uno.name', n);
    return n;
  }

  busy(on, text = '') {
    for (const id of ['#btn-host', '#btn-join', '#btn-join-toggle', '#btn-resume', '#btn-room-join', '#btn-room-host', '#btn-room-open']) $(id).disabled = on;
    $('#btn-room-cancel').hidden = true;
    $('#home-error').textContent = text;
    $('#home-error').classList.toggle('info', on);
  }

  // Owner of the private room: check the password with the server, then open it.
  async openRoom() {
    const password = $('#room-password');
    if (!this.myName()) return;
    this.busy(true, 'Checking the password…');
    try {
      await login(password.value);
    } catch (err) {
      this.busy(false, err.message);
      this.refreshHome();
      return;
    }
    password.value = '';
    $('#room-login').hidden = true;
    this.host(null, this.room);
  }

  async host(saved = null, room = null) {
    const name = this.myName();
    if (!name) return;
    this.busy(true, saved ? `Resuming game ${codeLabel(saved.pin)}…` : room ? `Opening ${codeLabel(room)}…` : 'Creating game…');
    const h = new Host({ name, ui: this, saved, room, turnMs: TURN_MS });
    try {
      this.session = h;
      this.pin = await h.start();
      this.renderChat(); // shows the (new) PIN to invite people with
      session.set('uno.session', 'host');
      this.busy(false);
    } catch (err) {
      h.close();
      if (this.session === h) this.session = null;
      this.busy(false, err.message);
    }
    this.refreshHome();
  }

  inviteLink() {
    if (isRoom(this.pin)) return roomLink(this.pin);
    const u = new URL(location.href);
    u.search = '';
    u.searchParams.set('pin', this.pin);
    if (isLocalMode) u.searchParams.set('local', '1');
    return u.toString();
  }

  async join(pin) {
    const name = this.myName();
    if (!name) return;
    this.busy(true, 'Connecting…');
    const c = new Client({ name, ui: this });
    try {
      this.session = c;
      this.pin = pin;
      // One automatic retry for network hiccups; a refusal from the host is final.
      for (let attempt = 0; ; attempt++) {
        try {
          await c.join(pin);
          break;
        } catch (err) {
          if (this.session !== c) throw err;
          // Private room not open yet: keep waiting until the host opens it.
          if (err.code === 'no-host' && isRoom(pin)) {
            this.busy(true, `Waiting for the host to open ${codeLabel(pin)}…`);
            $('#btn-room-cancel').hidden = false;
            await new Promise((r) => setTimeout(r, RETRY_MS));
            if (this.session !== c) throw err;
            attempt = -1;
            continue;
          }
          if (err.fromHost || attempt >= 1) throw err;
          this.busy(true, 'Connection failed, retrying…');
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      session.set('uno.session', 'client');
      this.busy(false);
    } catch (err) {
      if (this.session !== c) return; // stopped waiting, or left
      c.close();
      this.session = null;
      session.del('uno.session');
      this.busy(false, err.message);
    }
    this.refreshHome();
  }

  stopWaiting() {
    if (this.session instanceof Client) this.session.close();
    this.session = null;
    this.busy(false);
    this.refreshHome();
  }

  leave() {
    if (this.session instanceof Host) this.session.end();
    else if (this.session) this.session.close();
    this.session = null;
    this.state = null;
    this.hostIsAway = false;
    this.table.reset();
    this.chatLines = [];
    this.chatSeats = null;
    this.renderChat();
    this.toggleChat(false);
    session.del('uno.session');
    $('#overlay').hidden = true;
    this.show('home');
    this.refreshHome();
  }

  show(name) {
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === `screen-${name}`);
  }

  copy(text, done) {
    const fallback = () => prompt('Copy this:', text);
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => this.toast(done), fallback);
    else fallback();
  }

  toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  disconnected(why) {
    if (!this.session) return;
    this.session.close();
    this.session = null;
    session.del('uno.session');
    this.overlay('Disconnected', { text: why || 'Connection lost' });
  }

  hostAway(on) {
    this.hostIsAway = on;
    const st = this.state;
    if (on && st && st.phase === 'lobby') $('#lobby-status').textContent = 'The host left. Waiting for them to come back…';
    if (st && st.phase === 'ended' && !$('#overlay').hidden && !this.isHost) {
      $('#overlay-text').textContent = on ? 'The host is away. Waiting for them to come back…' : 'Waiting for the host to start the next round…';
    }
    this.rerender();
  }

  // ---- chat ----
  toggleChat(open = !$('#chat').classList.contains('open')) {
    $('#chat').classList.toggle('open', open);
    $('#btn-chat').setAttribute('aria-expanded', String(open));
    if (open) {
      this.unread = 0;
      this.renderUnread();
      const log = $('#chat-log');
      log.scrollTop = log.scrollHeight;
      if (window.matchMedia('(pointer: fine)').matches) $('#chat-input').focus();
    }
  }

  setChat(list) {
    this.chatLines = list.filter(validChat).slice(-CHAT_KEEP);
    this.renderChat();
  }

  addChat(e) {
    if (!validChat(e)) return;
    this.chatLines.push(e);
    if (this.chatLines.length > CHAT_KEEP) this.chatLines.shift();
    if (e.kind === 'chat') {
      // Messages also pop up as speech bubbles at the sender's seat.
      const p = this.state && this.state.players.find((x) => x.id === e.pid);
      if (p && this.state.phase !== 'lobby') this.table.bubble(p.seat, e.text.length > 60 ? `${e.text.slice(0, 58)}…` : e.text, 'say');
      if (e.pid !== this.me) {
        sound.chat();
        if (!$('#chat').classList.contains('open')) { this.unread += 1; this.renderUnread(); }
      }
    }
    // Only the new line goes into the log, so screen readers read just that one.
    const log = $('#chat-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.append(this.chatLine(e));
    const lines = log.querySelectorAll('li:not(.invite)');
    for (let i = 0; i < lines.length - CHAT_KEEP; i++) lines[i].remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  renderUnread() {
    const b = $('#chat-unread');
    b.hidden = !this.unread;
    b.textContent = this.unread > 9 ? '9+' : String(this.unread || '');
  }

  chatLine(e) {
    const li = document.createElement('li');
    if (e.kind === 'sys') {
      li.className = 'sys';
      li.textContent = e.text;
      return li;
    }
    const p = ((this.state && this.state.players) || []).find((x) => x.id === e.pid);
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = `${e.name}:`;
    who.style.color = p && p.seat >= 0 ? seatColor(p.seat) : 'var(--yellow)';
    li.className = 'msg';
    li.append(who, document.createTextNode(e.text));
    return li;
  }

  // The whole log again (joining, a new PIN, seats handed out). Screen
  // readers aren't told; they only hear lines added after (addChat).
  renderChat() {
    const log = $('#chat-log');
    const items = [];
    if (this.pin) {
      const li = document.createElement('li');
      li.className = 'sys invite';
      const b = document.createElement('b');
      b.textContent = isRoom(this.pin) ? `${location.host}/${this.pin}` : this.pin;
      li.append(isRoom(this.pin) ? 'Friends join at ' : 'Invite friends with PIN ', b);
      items.push(li);
    }
    for (const e of this.chatLines) items.push(this.chatLine(e));
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.setAttribute('aria-live', 'off');
    log.replaceChildren(...items);
    clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => log.setAttribute('aria-live', 'polite'), 200);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  renderClock() {
    const s = this.state;
    const el = $('#game-clock');
    if (!s || s.phase === 'lobby' || this.hostIsAway) return; // frozen while the host is away
    el.textContent = formatTime(gameTime(s, Date.now() + this.clockOffset));
    el.classList.toggle('stopped', !s.clock || s.clock.since === null);
  }

  overlay(title, { subtitle = '', board = null, text = '', again = false, results = '' } = {}) {
    $('#overlay-title').textContent = title;
    $('#overlay-sub').textContent = subtitle;
    $('#overlay-board').replaceChildren(...(board ? [board] : []));
    $('#overlay-text').textContent = text;
    $('#btn-again').hidden = !again;
    this.results = results;
    $('#btn-copy-results').hidden = !results;
    $('#overlay').hidden = false;
  }

  showScoreboard(state, isHost) {
    const sb = scoreboard(state, { me: this.me, now: Date.now() + this.clockOffset });
    this.overlay(resultsTitle(state, this.me), {
      subtitle: resultsSubtitle(state, sb.total),
      board: sb.table,
      text: isHost ? '' : this.hostIsAway ? 'The host is away. Waiting for them to come back…' : 'Waiting for the host to start the next round…',
      again: isHost,
      results: sb.text,
    });
  }

  // ---- rendering ----
  render(state, me, isHost, turnMs, hostNow = Date.now()) {
    this.clockOffset = hostNow - Date.now();
    this.state = state;
    this.me = me;
    this.isHost = isHost;
    // Chat names take their seat colors once seats are handed out.
    const seats = state.players.map((p) => `${p.id}@${p.seat}`).join(',');
    if (seats !== this.chatSeats) { this.chatSeats = seats; this.renderChat(); }
    if (state.phase === 'lobby') {
      $('#overlay').hidden = true;
      this.table.closePicker();
      this.table.selected = [];
      this.table.lastEventId = state.eventId;
      this.renderLobby(state, me, isHost);
      this.show('lobby');
      return;
    }
    this.show('game');
    this.renderGame(state, me, turnMs);
    // A flag, not prev/state comparison: the host re-renders fresh views each time.
    if (state.phase !== 'ended') this.endShown = false;
    else if (!this.endShown) {
      this.endShown = true;
      const winner = playerBySeat(state, state.winner);
      roundEndSound(!!winner && winner.id === me);
      setTimeout(() => { if (this.state && this.state.phase === 'ended') this.showScoreboard(this.state, this.isHost); }, RESULTS_DELAY);
    }
  }

  rerender() {
    if (this.state && this.state.phase !== 'lobby') this.renderGame(this.state, this.me, null);
  }

  renderLobby(state, me, isHost) {
    const room = isRoom(this.pin);
    $('#pin-label').textContent = room ? 'Private room' : 'Game PIN';
    $('#btn-copy-pin').hidden = room;
    $('#pin-display').replaceChildren(...Array.from(codeLabel(this.pin || '')).map((d) => Object.assign(document.createElement('span'), { textContent: d })));
    for (const input of document.querySelectorAll('#rules input')) {
      input.checked = !!state.rules[input.dataset.rule];
      input.disabled = !isHost;
    }
    $('#rules-text').textContent = isHost ? 'Pick any, or none. They work together.' : 'The host picks the house rules.';
    $('#player-count').textContent = `${state.players.length}/${MAX_PLAYERS}`;
    const ul = $('#lobby-players');
    ul.replaceChildren(...state.players.map((p) => {
      const li = document.createElement('li');
      li.append(avatar(p.name, -1, { bot: !!p.cpu }));
      const name = document.createElement('span');
      name.className = 'pname';
      name.textContent = p.name;
      li.append(name);
      if (state.round > 0) li.append(badge(`${state.totals[p.id] || 0} pts`, 'pts'));
      if (p.cpu) li.append(badge('Bot', 'bot'));
      if (p.host) li.append(badge('Host', 'host'));
      if (!p.connected && !p.cpu && !p.host) li.append(badge('away', 'away')); // the host just resumed: on their way back
      if (p.id === me) li.append(badge('You', 'you'));
      if (isHost && !p.host) {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'kick';
        x.title = `Remove ${p.name}`;
        x.setAttribute('aria-label', `Remove ${p.name}`);
        x.textContent = '✕';
        x.addEventListener('click', () => { if (this.session instanceof Host) this.session.kick(p.id); });
        li.append(x);
      }
      return li;
    }));
    const enough = state.players.length >= MIN_PLAYERS;
    $('#btn-start').hidden = !isHost;
    $('#btn-start').disabled = !enough;
    $('#btn-start').textContent = state.round > 0 ? `Start round ${state.round + 1}` : 'Start game';
    $('#btn-add-bot').hidden = !isHost;
    $('#btn-add-bot').disabled = state.players.length >= MAX_PLAYERS;
    $('#lobby-status').textContent = isHost
      ? (enough ? 'Ready when you are.' : room ? `Friends join at /${this.pin}, or add a bot to play right away.` : 'Share the PIN, or add a bot to play right away.')
      : this.hostIsAway ? 'The host left. Waiting for them to come back…' : 'Waiting for the host to start the game…';
  }

  renderGame(state, me, turnMs) {
    // While the host is unreachable, show the host as away too.
    const players = state.players.map((p) => (p.host && this.hostIsAway && !this.isHost ? { ...p, connected: false, bot: false } : p));
    const away = awayPlayers({ ...state, players });
    const paused = away.length > 0;
    const mine = players.find((p) => p.id === me);
    this.table.render(state, me, { players, isHost: this.isHost, turnMs });

    this.renderClock();
    $('#round-label').textContent = `Round ${state.round}`;
    $('#rule-chips').replaceChildren(...ruleChips(state.rules));
    $('#chat-count').textContent = `${players.filter((p) => p.connected).length} online`;

    // Banners
    $('#pause-banner').hidden = !paused;
    $('#afk-banner').hidden = !(mine && mine.afk && state.phase === 'playing');
    if (paused) {
      const names = away.map((p) => (p.id === me ? 'you' : p.name)).join(', ');
      $('#pause-text').textContent = this.hostIsAway && !this.isHost
        ? `Paused: the host (${away.find((p) => p.host)?.name || 'host'}) is away. Waiting for them to come back…`
        : `Paused: waiting for ${names} to come back…${this.isHost && this.pin ? (isRoom(this.pin) ? ` They can rejoin at /${this.pin}.` : ` They can rejoin with PIN ${this.pin}.`) : ''}`;
      $('#btn-continue').hidden = !(this.session instanceof Host);
      $('#btn-invite').hidden = !(this.session instanceof Host);
    }
  }
}

new UI();
