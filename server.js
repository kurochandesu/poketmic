const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os   = require('os');

const app = express();
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {h
  maxHttpBufferSize: 2e7,
  pingTimeout: 10000,
  pingInterval: 5000,
});

// ===== 状態管理 =====
const speakers      = new Map();
const outputClients = new Set();
const adminClients  = new Set();
let roomCode = Math.random().toString(36).substring(2,8).toUpperCase();

// ===== ミキシングループ =====
const MIX_MS = 50;

function mixBuffers(list) {
  if (!list.length) return null;
  const len = list[0].length;
  const out = new Float32Array(len);
  for (const b of list) for (let i = 0; i < Math.min(len, b.length); i++) out[i] += b[i];
  for (let i = 0; i < len; i++) out[i] = Math.tanh(out[i] * 0.8);
  return out;
}

setInterval(() => {
  const now = Date.now();
  const bufs = [];
  for (const [, s] of speakers) {
    if (s.buffer && !s.muted && now - s.lastTime < MIX_MS * 4) {
      bufs.push(s.buffer); s.buffer = null;
    }
  }
  if (!bufs.length) return;
  const mixed = mixBuffers(bufs);
  if (!mixed) return;
  const i16 = new Int16Array(mixed.length);
  for (let i = 0; i < mixed.length; i++)
    i16[i] = Math.max(-32768, Math.min(32767, mixed[i] * 32768));
  const payload = Buffer.from(i16.buffer);
  for (const id of outputClients) io.to(id).emit('audio', payload);
}, MIX_MS);

// ===== ソケットイベント =====
io.on('connection', socket => {
  socket.on('register', ({ type, name, code }) => {
    if (type === 'speaker') {
      if (code !== roomCode) { socket.emit('error', 'ルームコードが違います'); return; }
      const n = name || `参加者${speakers.size + 1}`;
      speakers.set(socket.id, { name: n, buffer: null, lastTime: 0, active: false, muted: false });
      socket.emit('registered', { name: n });
      broadcastList();
    } else if (type === 'output') {
      outputClients.add(socket.id);
    } else if (type === 'admin') {
      adminClients.add(socket.id);
      socket.emit('roomInfo', { code: roomCode, speakers: speakerList() });
    }
  });

  socket.on('audio', data => {
    const s = speakers.get(socket.id);
    if (!s || s.muted) return;
    const i16 = new Int16Array(data.buffer || data);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    s.buffer = f32; s.lastTime = Date.now();
    if (!s.active) { s.active = true; notifyActive(socket.id, true); }
  });

  socket.on('micOff', () => {
    const s = speakers.get(socket.id);
    if (s && s.active) { s.active = false; s.buffer = null; notifyActive(socket.id, false); }
  });

  socket.on('muteSpeaker', ({ id, muted }) => {
    const s = speakers.get(id);
    if (!s) return;
    s.muted = muted;
    io.to(id).emit('muteStatus', { muted });
    broadcastList();
  });

  socket.on('resetRoom', () => {
    if (!adminClients.has(socket.id)) return;
    roomCode = Math.random().toString(36).substring(2,8).toUpperCase();
    for (const id of adminClients) io.to(id).emit('roomInfo', { code: roomCode, speakers: speakerList() });
  });

  socket.on('disconnect', () => {
    const was = speakers.has(socket.id);
    speakers.delete(socket.id); outputClients.delete(socket.id); adminClients.delete(socket.id);
    if (was) broadcastList();
  });
});

function speakerList() {
  return Array.from(speakers.entries()).map(([id,s]) => ({ id, name:s.name, active:s.active, muted:s.muted }));
}
function broadcastList() {
  const list = speakerList();
  for (const id of adminClients) io.to(id).emit('speakerList', list);
}
function notifyActive(id, active) {
  for (const aid of adminClients) io.to(aid).emit('speakerActive', { id, active });
}

// ===== 起動 =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n========================================');
  console.log('  🎤 PoketMic サーバー起動！');
  console.log('========================================');
  console.log(`  ポート         : ${PORT}`);
  console.log(`  ルームコード   : ${roomCode}`);
  console.log('========================================\n');
});
