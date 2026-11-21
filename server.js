import http from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data', 'rooms');
const PORT = process.env.PORT || 3000;
const MAIN_ROOM = 'main';
const ROOM_PASSWORD = process.env.ROOM_PASSWORD || 'avii';

// roomCode -> { messages: [], members: Map<clientId, {name, lastSeen}> }
const rooms = new Map();
// roomCode -> Set of SSE response objects
const subscribers = new Map();
// clientId -> roomCode
const clientRooms = new Map();

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

function roomFile(code) {
  return path.join(DATA_DIR, `${code}.json`);
}

async function loadRoom(code) {
  if (rooms.has(code)) return rooms.get(code);
  let messages = [], name = null, password = null;
  try {
    const raw = await readFile(roomFile(code), 'utf8');
    const data = JSON.parse(raw);
    messages = data.messages || [];
    name = data.name || null;
    password = data.password || null;
  } catch {}
  const room = { messages, members: new Map(), name, password };
  rooms.set(code, room);
  return room;
}

function saveRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  writeFile(roomFile(code), JSON.stringify({ name: room.name, password: room.password, messages: room.messages })).catch(() => {});
}

function broadcast(code, event) {
  const subs = subscribers.get(code);
  if (!subs) return;
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of subs) {
    try { res.write(payload); } catch {}
  }
}

function broadcastMembers(code) {
  const room = rooms.get(code);
  if (!room) return;
  const members = [...room.members.values()];
  broadcast(code, { type: 'members', members });
}

function newCode() {
  return crypto.randomBytes(4).toString('hex');
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function passOk(req, url, room, body) {
  if (!room.password) return true;
  const p = req.headers['x-room-pass'] || url.searchParams.get('pass') || body?.pass;
  return p === room.password;
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  // POST /api/rooms { name? } -> { code }
  if (req.method === 'POST' && parts[1] === 'rooms' && parts.length === 2) {
    const code = newCode();
    const room = await loadRoom(code);
    const body = await readBody(req);
    if (body.name?.trim()) {
      room.name = body.name.trim().slice(0, 60);
      saveRoom(code);
    }
    return json(res, 200, { code });
  }

  // GET /api/rooms/:code -> room info + history
  if (req.method === 'GET' && parts[1] === 'rooms' && parts[2] && parts.length === 3) {
    const code = parts[2];
    const room = await loadRoom(code);
    if (!passOk(req, url, room)) return json(res, 401, { error: 'pass' });
    return json(res, 200, { code, name: room.name, messages: room.messages });
  }

  // POST /api/rooms/:code/messages { clientId, author, text, replyTo? }
  if (req.method === 'POST' && parts[1] === 'rooms' && parts[3] === 'messages') {
    const code = parts[2];
    const room = await loadRoom(code);
    const body = await readBody(req);
    if (!passOk(req, url, room, body)) return json(res, 401, { error: 'pass' });
    const { clientId, author, text, replyTo, audio, image, file } = body;
    const hasFile = file && typeof file.data === 'string' && file.data.startsWith('data:') && file.data.length < 14_000_000;
    if (!author || (!text?.trim() && !audio && !image && !hasFile)) return json(res, 400, { error: 'author and content required' });
    const msg = {
      id: crypto.randomUUID(),
      author,
      clientId: clientId || null,
      text: (text || '').trim().slice(0, 4000),
      audio: typeof audio === 'string' && audio.startsWith('data:audio/') ? audio.slice(0, 8_000_000) : null,
      image: typeof image === 'string' && image.startsWith('data:image/') ? image.slice(0, 8_000_000) : null,
      file: hasFile ? { name: String(file.name || 'file').slice(0, 120), data: file.data } : null,
      replyTo: replyTo || null,
      ts: Date.now(),
    };
    room.messages.push(msg);
    if (room.messages.length > 500) room.messages = room.messages.slice(-500);
    saveRoom(code);
    broadcast(code, { type: 'message', message: msg });
    return json(res, 200, { message: msg });
  }

  // POST /api/rooms/:code/join { clientId, name }
  if (req.method === 'POST' && parts[1] === 'rooms' && parts[3] === 'join') {
    const code = parts[2];
    const room = await loadRoom(code);
    const body = await readBody(req);
    if (!passOk(req, url, room, body)) return json(res, 401, { error: 'pass' });
    const { clientId, name } = body;
    if (!clientId || !name?.trim()) return json(res, 400, { error: 'clientId and name required' });
    const prev = room.members.get(clientId);
    room.members.set(clientId, { id: clientId, name: name.trim().slice(0, 40), lastSeen: Date.now(), lastRead: prev?.lastRead || null });
    clientRooms.set(clientId, code);
    broadcastMembers(code);
    broadcast(code, { type: 'join', member: { id: clientId, name: name.trim(), lastSeen: Date.now() } });
    return json(res, 200, { ok: true, members: [...room.members.values()] });
  }

  // POST /api/rooms/:code/edit { clientId, id, text }
  if (req.method === 'POST' && parts[1] === 'rooms' && parts[3] === 'edit') {
    const code = parts[2];
    const room = await loadRoom(code);
    const body = await readBody(req);
    if (!passOk(req, url, room, body)) return json(res, 401, { error: 'pass' });
    const { clientId, id, text } = body;
    const msg = room.messages.find(m => m.id === id);
    if (!msg || msg.clientId !== clientId) return json(res, 403, { error: 'forbidden' });
    if (!text?.trim()) return json(res, 400, { error: 'text required' });
    msg.text = text.trim().slice(0, 4000);
    msg.edited = true;
    saveRoom(code);
    broadcast(code, { type: 'update', message: msg });
    return json(res, 200, { message: msg });
  }

  // POST /api/rooms/:code/delete { clientId, id }
  if (req.method === 'POST' && parts[1] === 'rooms' && parts[3] === 'delete') {
    const code = parts[2];
    const room = await loadRoom(code);
    const body = await readBody(req);
    if (!passOk(req, url, room, body)) return json(res, 401, { error: 'pass' });
    const { clientId, id } = body;
    const idx = room.messages.findIndex(m => m.id === id);
    if (idx === -1 || room.messages[idx].clientId !== clientId) return json(res, 403, { error: 'forbidden' });
    room.messages.splice(idx, 1);
    saveRoom(code);
    broadcast(code, { type: 'delete', id });
    return json(res, 200, { ok: true });
  }

  // POST /api/rooms/:code/read { clientId, ts } — read receipt
  if (req.method === 'POST' && parts[1] === 'rooms' && parts[3] === 'read') {
    const code = parts[2];
    const room = await loadRoom(code);
    const body = await readBody(req);
    if (!passOk(req, url, room, body)) return json(res, 401, { error: 'pass' });
    const { clientId, ts } = body;
    const member = room?.members.get(clientId);
    if (member && typeof ts === 'number' && ts > (member.lastRead || 0)) {
      member.lastRead = ts;
      broadcast(code, { type: 'read', clientId, ts });
    }
    return json(res, 200, { ok: true });
  }

  // POST /api/rooms/:code/leave { clientId }
  if (req.method === 'POST' && parts[1] === 'rooms' && parts[3] === 'leave') {
    const code = parts[2];
    const room = rooms.get(code);
    const { clientId } = await readBody(req);
    if (room && clientId) {
      room.members.delete(clientId);
      clientRooms.delete(clientId);
      broadcastMembers(code);
      broadcast(code, { type: 'leave', memberId: clientId });
    }
    return json(res, 200, { ok: true });
  }

  // GET /api/rooms/:code/events?clientId=...&pass=... -> SSE stream
  if (req.method === 'GET' && parts[1] === 'rooms' && parts[3] === 'events') {
    const code = parts[2];
    const clientId = url.searchParams.get('clientId') || '';
    const room = await loadRoom(code);
    if (!passOk(req, url, room)) return json(res, 401, { error: 'pass' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    if (!subscribers.has(code)) subscribers.set(code, new Set());
    subscribers.get(code).add(res);
    if (clientId) clientRooms.set(clientId, code);

    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      subscribers.get(code)?.delete(res);
      if (clientId) {
        const room = rooms.get(code);
        if (room?.members.delete(clientId)) {
          broadcastMembers(code);
          broadcast(code, { type: 'leave', memberId: clientId });
        }
        clientRooms.delete(clientId);
      }
    });
    return;
  }

  return json(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    // static files
    let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    try {
      const data = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

await ensureDataDir();
// ensure the single main room exists and is password-protected
{
  const main = await loadRoom(MAIN_ROOM);
  main.name = 'Thallisaa';
  if (!main.password) { main.password = ROOM_PASSWORD; saveRoom(MAIN_ROOM); }
}
server.listen(PORT, () => {
  console.log(`Chat app running at http://localhost:${PORT}`);
});
