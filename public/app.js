const $ = (id) => document.getElementById(id);
const ROOM = 'main';

/* ================= State ================= */
const state = {
  clientId: localStorage.clientId || crypto.randomUUID(),
  pass: localStorage.wc_pass || '',
  members: new Map(),
  lastSeen: new Map(),
};
localStorage.clientId = state.clientId;
const AUTHOR = 'Me';

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      'x-room-pass': state.pass,
    },
    ...opts,
  });
  return res.json();
}

/* ================= Boot ================= */
init();
async function init() {
  if (state.pass) {
    const ok = await tryUnlock(state.pass, true);
    if (ok) return;
  }
  showLock();
}

function showLock() {
  $('lockView').classList.remove('hidden');
  $('chatView').classList.add('hidden');
  $('lockPass').value = '';
  $('lockPass').focus();
}

$('lockPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
$('unlockBtn').addEventListener('click', unlock);

async function unlock() {
  const pass = $('lockPass').value;
  if (!pass) return $('lockError').textContent = 'Enter the password';
  const ok = await tryUnlock(pass);
  if (!ok) $('lockError').textContent = 'Wrong password';
}

async function tryUnlock(pass, silent = false) {
  state.pass = pass;
  localStorage.wc_pass = pass;
  localStorage.removeItem('wc_name');

  const info = await api(`/api/rooms/${ROOM}`);
  if (info.error === 'pass') {
    if (!silent) return false;
    localStorage.removeItem('wc_pass');
    state.pass = '';
    return false;
  }

  const joinRes = await api(`/api/rooms/${ROOM}/join`, {
    method: 'POST',
    body: JSON.stringify({ clientId: state.clientId, name: AUTHOR, pass }),
  });
  if (joinRes.members) {
    state.members = new Map(joinRes.members.map(m => [m.id, m]));
  }
  if (joinRes.lastSeen) {
    state.lastSeen = new Map(Object.entries(joinRes.lastSeen));
  }

  $('lockView').classList.add('hidden');
  $('chatView').classList.remove('hidden');
  connectSSE();
  renderHistory(info.messages || []);
  scrollBottom();
  refreshTicks();
  updateSubtitle();
  return true;
}

$('lockBtn').addEventListener('click', () => {
  state.members.clear();
  location.reload();
});

/* ================= SSE ================= */
function connectSSE() {
  const es = new EventSource(`/api/rooms/${ROOM}/events?clientId=${state.clientId}&pass=${encodeURIComponent(state.pass)}`);

  es.addEventListener('members', (e) => {
    const { members, lastSeen } = JSON.parse(e.data);
    state.members = new Map(members.map(m => [m.id, m]));
    if (lastSeen) state.lastSeen = new Map(Object.entries(lastSeen));
    if (othersOnline()) {
      for (const t of tickMap.values()) {
        if (t.status === 'sent') t.status = 'delivered';
      }
    }
    updateSubtitle();
    refreshTicks();
  });
  es.addEventListener('read', (e) => {
    const { clientId, ts } = JSON.parse(e.data);
    const m = state.members.get(clientId);
    if (m) m.lastRead = Math.max(m.lastRead || 0, ts);
    for (const t of tickMap.values()) {
      if (t.ts <= ts) t.status = 'read';
    }
    refreshTicks();
  });
  es.addEventListener('join', (e) => {
    const { member } = JSON.parse(e.data);
    if (member.id !== state.clientId) {
      toast('They are here');
      state.members.set(member.id, member);
      updateSubtitle();
    }
  });
  es.addEventListener('leave', (e) => {
    const { memberId } = JSON.parse(e.data);
    if (memberId !== state.clientId) {
      toast('They left');
      state.members.delete(memberId);
      updateSubtitle();
    }
  });
  es.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data).message;
    appendMessage(msg);
    if (msg.clientId !== state.clientId) sendRead(msg.ts);
  });
  es.addEventListener('update', () => reloadHistory());
  es.addEventListener('delete', () => reloadHistory());
  es.onerror = () => {
    $('chatSubtitle').textContent = 'reconnecting…';
  };
}

async function reloadHistory() {
  const info = await api(`/api/rooms/${ROOM}`);
  if (info.messages) {
    renderHistory(info.messages);
    scrollBottom();
    refreshTicks();
  }
}

function othersOnline() {
  return [...state.members.values()].some(m => m.id !== state.clientId);
}

function fmtLastSeen(ts) {
  const d = new Date(ts), now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `today at ${time}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `yesterday at ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} at ${time}`;
}

function updateSubtitle() {
  if (othersOnline()) { $('chatSubtitle').textContent = 'online'; return; }
  const seen = [...state.lastSeen.entries()]
    .filter(([id]) => id !== state.clientId)
    .map(([, ts]) => ts).sort((a, b) => b - a)[0];
  $('chatSubtitle').textContent = seen ? `last seen ${fmtLastSeen(seen)}` : 'waiting for them…';
}

/* ================= Message rendering ================= */
const GROUP_WINDOW = 5 * 60 * 1000;
let lastRendered = null;
const tickMap = new Map(); // msgId -> {el, ts}
const msgStore = new Map(); // msgId -> msg
let lastReadSent = 0;

function sendRead(ts) {
  if (!ts || ts <= lastReadSent) return;
  lastReadSent = ts;
  api(`/api/rooms/${ROOM}/read`, {
    method: 'POST',
    body: JSON.stringify({ clientId: state.clientId, ts, pass: state.pass }),
  }).catch(() => {});
}

function refreshTicks() {
  for (const t of tickMap.values()) {
    t.el.textContent = t.status === 'sent' ? '✓' : '✓✓';
    t.el.classList.toggle('read', t.status === 'read');
  }
}

function sameGroupId(a, b) {
  const aid = a.clientId || a.author, bid = b.clientId || b.author;
  return aid === bid && (b.ts - a.ts) < GROUP_WINDOW && sameDayTs(a.ts, b.ts);
}
function sameDayTs(a, b) { return new Date(a).toDateString() === new Date(b).toDateString(); }

function renderHistory(msgs) {
  const box = $('messages');
  box.innerHTML = '';
  tickMap.clear();
  msgStore.clear();
  for (let i = 0; i < msgs.length; i++) {
    const prev = msgs[i - 1], next = msgs[i + 1];
    const grouped = prev && sameGroupId(prev, msgs[i]);
    const isLast = !next || !sameGroupId(msgs[i], next);
    appendMessageEl(msgs[i], { grouped, tail: isLast, scroll: false });
  }
  const last = msgs[msgs.length - 1];
  lastRendered = last ? {
    authorId: last.clientId || last.author,
    ts: last.ts,
    bubble: box.lastElementChild?.querySelector('.bubble'),
  } : null;
  if (last && last.clientId !== state.clientId) sendRead(last.ts);
}

function appendMessage(msg) {
  const mine = msg.clientId === state.clientId;
  const authorId = msg.clientId || msg.author;
  const grouped = lastRendered && authorId === lastRendered.authorId && (msg.ts - lastRendered.ts) < GROUP_WINDOW;
  if (grouped && lastRendered.bubble) lastRendered.bubble.classList.remove('tail');
  appendMessageEl(msg, { grouped, tail: true });
  lastRendered = {
    authorId, ts: msg.ts,
    bubble: $('messages').lastElementChild?.querySelector('.bubble'),
  };
}

function appendMessageEl(msg, { grouped = false, tail = true, scroll = true } = {}) {
  const box = $('messages');
  const mine = msg.clientId === state.clientId;

  if (!lastRendered || !sameDayTs(lastRendered.ts, msg.ts)) {
    const div = document.createElement('div');
    div.className = 'date-divider';
    div.textContent = fmtDateChip(msg.ts);
    box.appendChild(div);
  }

  const row = document.createElement('div');
  row.className = `msg-row ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''}`;
  row.dataset.mid = msg.id;
  msgStore.set(msg.id, msg);

  const bubble = document.createElement('div');
  bubble.className = 'bubble' + (tail ? ' tail' : '');

  if (msg.image) {
    const img = document.createElement('img');
    img.className = 'chat-img';
    img.src = msg.image;
    img.alt = 'photo';
    img.addEventListener('click', () => window.open(msg.image, '_blank'));
    bubble.appendChild(img);
  }
  if (msg.audio) {
    const wrap = document.createElement('div');
    wrap.className = 'voice-wrap';
    wrap.innerHTML = `<span class="voice-icon">🎤</span>`;
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = msg.audio;
    audio.preload = 'metadata';
    wrap.appendChild(audio);
    bubble.appendChild(wrap);
  }
  if (msg.file) {
    const a = document.createElement('a');
    a.className = 'file-chip';
    a.href = msg.file.data;
    a.download = msg.file.name || 'file';
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = '📎';
    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = msg.file.name || 'file';
    const sizeEl = document.createElement('span');
    sizeEl.className = 'file-size';
    sizeEl.textContent = fmtSize(msg.file.data);
    a.append(icon, nameEl, sizeEl);
    bubble.appendChild(a);
  }
  if (msg.text) bubble.appendChild(document.createTextNode(msg.text));

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.appendChild(document.createTextNode(
    (msg.edited ? 'edited ' : '') + fmtTime(msg.ts)));
  if (mine) {
    meta.appendChild(document.createTextNode(' '));
    const ticks = document.createElement('span');
    ticks.className = 'ticks';
    meta.appendChild(ticks);
    tickMap.set(msg.id, { el: ticks, ts: msg.ts, status: othersOnline() ? 'delivered' : 'sent' });
  }
  bubble.appendChild(meta);

  row.appendChild(bubble);
  box.appendChild(row);
  if (scroll) scrollBottom();
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtSize(dataUrl) {
  const bytes = Math.round((dataUrl.length * 0.75));
  if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function fmtDateChip(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'TODAY';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'YESTERDAY';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase();
}
function scrollBottom() {
  const box = $('messages');
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
}

/* ================= Composer ================= */
const textInput = $('textInput');

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  toggleSendMic();
  await sendMessage({ text });
});

async function sendMessage(payload) {
  await api(`/api/rooms/${ROOM}/messages`, {
    method: 'POST',
    body: JSON.stringify({ clientId: state.clientId, author: AUTHOR, pass: state.pass, ...payload }),
  });
}

function toggleSendMic() {
  const hasText = textInput.value.trim().length > 0;
  $('sendBtn').classList.toggle('hidden', !hasText);
  $('micBtn').classList.toggle('hidden', hasText);
}
textInput.addEventListener('input', toggleSendMic);
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
});

/* --- emoji panel --- */
const EMOJIS = ['\u{1F600}','\u{1F602}','\u{1F979}','\u{1F60D}','\u{1F914}','\u{1F605}','\u{1F64F}','\u{1F44D}','\u{1F44E}','\u2764\u{FE0F}','\u{1F525}','\u{1F389}','\u{1F622}','\u{1F621}','\u{1F91D}','\u2728','\u{1F4AF}','\u{1F680}','\u26BD','\u{1F355}','\u2615','\u{1F382}','\u{1F339}','\u{1F634}','\u{1F917}'];
const emojiPanel = $('emojiPanel');
for (const e of EMOJIS) {
  const b = document.createElement('button');
  b.textContent = e;
  b.addEventListener('click', () => {
    const s = textInput.selectionStart ?? textInput.value.length;
    const t = textInput.value;
    textInput.value = t.slice(0, s) + e + t.slice(textInput.selectionEnd ?? s);
    textInput.focus();
    toggleSendMic();
  });
  emojiPanel.appendChild(b);
}
$('emojiBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  emojiPanel.classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!emojiPanel.contains(e.target) && e.target !== $('emojiBtn')) emojiPanel.classList.add('hidden');
});

/* --- image attach --- */
$('attachBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { toast('File too large (max ~8MB)'); return; }
  const caption = textInput.value.trim();
  textInput.value = '';
  toggleSendMic();
  if (file.type.startsWith('image/')) {
    const dataUrl = await fileToResizedDataUrl(file);
    if (dataUrl) await sendMessage({ image: dataUrl, text: caption });
  } else {
    const dataUrl = await readAsDataUrl(file);
    await sendMessage({ file: { name: file.name, data: dataUrl }, text: caption });
  }
});

function fileToResizedDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1600;
        let { width: w, height: h } = img;
        if (Math.max(w, h) > MAX) {
          const scale = MAX / Math.max(w, h);
          w = Math.round(w * scale); h = Math.round(h * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => resolve(reader.result);
      img.src = reader.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/* --- voice messages --- */
let mediaRecorder = null, recChunks = [], recStream = null, recTimer = null, recStart = 0;

$('micBtn').addEventListener('click', async () => {
  if (mediaRecorder) return stopRecording(true);
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast('Microphone access denied');
    return;
  }
  mediaRecorder = new MediaRecorder(recStream);
  recChunks = [];
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  mediaRecorder.onstop = () => {};
  mediaRecorder.start();
  recStart = Date.now();
  $('recBar').classList.remove('hidden');
  $('composer').classList.add('hidden');
  recTimer = setInterval(updateRecTime, 500);
});

function updateRecTime() {
  const s = Math.floor((Date.now() - recStart) / 1000);
  $('recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (s >= 60) stopRecording(true);
}

function stopRecording(send) {
  clearInterval(recTimer);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  recStream?.getTracks().forEach(t => t.stop());
  mediaRecorder = null;
  $('recBar').classList.add('hidden');
  $('composer').classList.remove('hidden');

  if (send && recChunks.length) {
    const blob = new Blob(recChunks, { type: recChunks[0].type || 'audio/webm' });
    const reader = new FileReader();
    reader.onload = () => sendMessage({ audio: reader.result });
    reader.readAsDataURL(blob);
  }
  recChunks = [];
}

$('recSend').addEventListener('click', () => stopRecording(true));
$('recCancel').addEventListener('click', () => stopRecording(false));

/* ================= Message context menu (edit/delete) ================= */
const ctxMenu = $('ctxMenu');
const messagesEl = $('messages');
let ctxMsgId = null, lpTimer = null;

function openCtxMenu(id, x, y) {
  ctxMsgId = id;
  ctxMenu.classList.remove('hidden');
  const mw = 140, mh = 90;
  const appRect = $('app').getBoundingClientRect();
  let left = x - appRect.left + 8;
  let top = y - appRect.top - 10;
  if (left + mw > appRect.width - 8) left = appRect.width - mw - 8;
  if (top + mh > appRect.height - 8) top = y - appRect.top - mh - 8;
  ctxMenu.style.left = Math.max(8, left) + 'px';
  ctxMenu.style.top = Math.max(8, top) + 'px';
}
function hideCtxMenu() { ctxMenu.classList.add('hidden'); ctxMsgId = null; }

messagesEl.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.msg-row.mine');
  if (!row) return;
  e.preventDefault();
  openCtxMenu(row.dataset.mid, e.clientX, e.clientY);
});
messagesEl.addEventListener('touchstart', (e) => {
  const row = e.target.closest('.msg-row.mine');
  if (!row) return;
  const id = row.dataset.mid;
  const t = e.touches[0];
  lpTimer = setTimeout(() => openCtxMenu(id, t.clientX, t.clientY), 500);
}, { passive: true });
['touchend', 'touchmove', 'touchcancel'].forEach(ev =>
  messagesEl.addEventListener(ev, () => clearTimeout(lpTimer)));
document.addEventListener('click', (e) => {
  if (!ctxMenu.contains(e.target)) hideCtxMenu();
});

$('ctxEdit').addEventListener('click', async () => {
  const m = msgStore.get(ctxMsgId);
  hideCtxMenu();
  if (!m) return;
  const t = prompt('Edit message:', m.text || '');
  if (t === null) return;
  const text = t.trim();
  if (!text || text === m.text) return;
  await api(`/api/rooms/${ROOM}/edit`, {
    method: 'POST',
    body: JSON.stringify({ clientId: state.clientId, id: ctxMsgId, text, pass: state.pass }),
  });
});

$('ctxDelete').addEventListener('click', async () => {
  const id = ctxMsgId;
  hideCtxMenu();
  if (!id || !confirm('Delete this message?')) return;
  await api(`/api/rooms/${ROOM}/delete`, {
    method: 'POST',
    body: JSON.stringify({ clientId: state.clientId, id, pass: state.pass }),
  });
  await reloadHistory();
});

/* ================= Theme picker ================= */
const THEMES = [
  { id: 'dots',     label: 'Classic',  bg: '#efeae2' },
  { id: 'blush',    label: 'Blush',    bg: '#fdf0f3' },
  { id: 'sky',      label: 'Sky',      bg: '#e8f4fd' },
  { id: 'lavender', label: 'Lavender', bg: '#f3effc' },
  { id: 'mint',     label: 'Mint',     bg: '#e9f9f3' },
  { id: 'sunset',   label: 'Sunset',   bg: 'linear-gradient(160deg,#fff3e0,#ffe0ec)' },
];

function applyTheme(id) {
  const app = $('app');
  for (const t of THEMES) app.classList.remove('theme-' + t.id);
  if (id !== 'dots') app.classList.add('theme-' + id);
  localStorage.wc_theme = id;
  document.querySelectorAll('.theme-opt').forEach(b =>
    b.classList.toggle('active', b.dataset.theme === id));
}

function initThemePicker() {
  const wrap = $('themeOptions');
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.className = 'theme-opt';
    b.dataset.theme = t.id;
    b.title = t.label;
    b.style.background = t.bg;
    b.addEventListener('click', () => { applyTheme(t.id); $('themePanel').classList.add('hidden'); });
    wrap.appendChild(b);
  }
  applyTheme(localStorage.wc_theme || 'dots');
}

$('menuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('themePanel').classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#themePanel') && e.target.id !== 'menuBtn')
    $('themePanel').classList.add('hidden');
});
initThemePicker();

/* --- dark mode --- */
function applyDark(on) {
  $('app').classList.toggle('dark', on);
  localStorage.wc_dark = on ? '1' : '';
  $('darkToggle').textContent = on ? '☀️ Light mode' : '🌙 Dark mode';
}
$('darkToggle').addEventListener('click', () => {
  applyDark(!$('app').classList.contains('dark'));
  $('themePanel').classList.add('hidden');
});
applyDark(localStorage.wc_dark === '1');

/* ================= Toast ================= */
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
}
