const $ = (id) => document.getElementById(id);
const ROOM = 'main';

/* ================= State ================= */
const state = {
  clientId: localStorage.clientId || crypto.randomUUID(),
  pass: localStorage.wc_pass || '',
  members: new Map(),
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
  if (!ok) $('lockError').textContent = 'Wrong password 💔';
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

  await api(`/api/rooms/${ROOM}/join`, {
    method: 'POST',
    body: JSON.stringify({ clientId: state.clientId, name: AUTHOR, pass }),
  });

  $('lockView').classList.add('hidden');
  $('chatView').classList.remove('hidden');
  connectSSE();
  renderHistory(info.messages || []);
  scrollBottom();
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
    const { members } = JSON.parse(e.data);
    state.members = new Map(members.map(m => [m.id, m]));
    updateSubtitle();
  });
  es.addEventListener('join', (e) => {
    const { member } = JSON.parse(e.data);
    if (member.id !== state.clientId) {
      toast('They are here 💕');
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
    appendMessage(JSON.parse(e.data).message);
  });
  es.onerror = () => {
    $('chatSubtitle').textContent = 'reconnecting…';
  };
}

function updateSubtitle() {
  const others = [...state.members.values()].filter(m => m.id !== state.clientId);
  $('chatSubtitle').textContent = others.length ? 'online 💕' : 'waiting for them…';
}

/* ================= Message rendering ================= */
const GROUP_WINDOW = 5 * 60 * 1000;
let lastRendered = null;

function sameGroupId(a, b) {
  const aid = a.clientId || a.author, bid = b.clientId || b.author;
  return aid === bid && (b.ts - a.ts) < GROUP_WINDOW && sameDayTs(a.ts, b.ts);
}
function sameDayTs(a, b) { return new Date(a).toDateString() === new Date(b).toDateString(); }

function renderHistory(msgs) {
  const box = $('messages');
  box.innerHTML = '';
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
  if (msg.text) bubble.appendChild(document.createTextNode(msg.text));

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.innerHTML = `${fmtTime(msg.ts)}${mine ? ' <span class="ticks">✓✓</span>' : ''}`;
  bubble.appendChild(meta);

  row.appendChild(bubble);
  box.appendChild(row);
  if (scroll) scrollBottom();
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
const EMOJIS = ['❤️','💕','💖','😘','😍','🥰','💋','💌','💐','🌹','💍','✨','💫','🌙','⭐','🥂','🍓','🍫','🧸','🎞️','💞','🫶','😏','😉','😚'];
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
  const dataUrl = await fileToResizedDataUrl(file);
  if (dataUrl) {
    const caption = textInput.value.trim();
    textInput.value = '';
    toggleSendMic();
    await sendMessage({ image: dataUrl, text: caption });
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

/* ================= Toast ================= */
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
}
