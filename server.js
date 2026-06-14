const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ── HTTP Server (serves index.html) ──
const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ── WebSocket Server ──
const wss = new WebSocketServer({ server });

// Game state
const players = new Map();        // id -> { name, x, y, z, yaw, pitch, health, tool, selectedBlock }
const blockChanges = [];           // [{x,y,z,type,by}] — persisted for session
const chatHistory = [];            // last 50 messages
let nextPlayerId = 1;

// Player colors for name tags
const PLAYER_COLORS = [
  '#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57',
  '#ff9ff3', '#54a0ff', '#5f27cd', '#01a3a4', '#f368e0',
  '#ff6348', '#2ed573', '#1e90ff', '#ffa502', '#a29bfe',
];

wss.on('connection', (ws) => {
  const id = nextPlayerId++;
  const color = PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length];
  let playerName = `Player${id}`;

  console.log(`[+] ${playerName} connected (id=${id})`);

  // Send welcome
  ws.send(JSON.stringify({
    type: 'welcome',
    id,
    color,
    // Send existing players
    players: Object.fromEntries(
      [...players.entries()].map(([pid, p]) => [pid, { ...p }])
    ),
    // Send all block changes since server start
    blockChanges,
    // Send recent chat
    chatHistory: chatHistory.slice(-20),
  }));

  // Notify others
  broadcast({ type: 'player_join', id, name: playerName, color }, ws);

  // Register player
  players.set(id, { name: playerName, color, x: 0, y: 40, z: 0, yaw: 0, pitch: 0, health: 20, tool: 'hand', selectedBlock: 0 });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'set_name': {
        const name = String(msg.name || '').trim().slice(0, 16) || `Player${id}`;
        playerName = name;
        const p = players.get(id);
        if (p) p.name = name;
        broadcast({ type: 'player_rename', id, name }, null);
        console.log(`[~] id=${id} renamed to "${name}"`);
        break;
      }

      case 'position': {
        // Player position update
        const p = players.get(id);
        if (p) {
          p.x = msg.x; p.y = msg.y; p.z = msg.z;
          p.yaw = msg.yaw; p.pitch = msg.pitch;
          p.health = msg.health;
          p.tool = msg.tool || 'hand';
          p.selectedBlock = msg.selectedBlock || 0;
        }
        // Broadcast to others
        broadcast({
          type: 'player_move',
          id, x: msg.x, y: msg.y, z: msg.z,
          yaw: msg.yaw, pitch: msg.pitch,
          health: msg.health,
          tool: msg.tool,
          selectedBlock: msg.selectedBlock,
        }, ws);
        break;
      }

      case 'block_change': {
        // Block placed or broken
        const change = { x: msg.x, y: msg.y, z: msg.z, blockType: msg.blockType, by: id };
        blockChanges.push(change);
        // Cap at 10000 changes
        if (blockChanges.length > 10000) blockChanges.splice(0, blockChanges.length - 10000);
        // Broadcast
        broadcast({ type: 'block_change', ...change }, ws);
        break;
      }

      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 200);
        if (!text) break;
        const chatMsg = { type: 'chat', id, name: playerName, color, text, time: Date.now() };
        chatHistory.push(chatMsg);
        if (chatHistory.length > 50) chatHistory.shift();
        broadcast(chatMsg, null); // send to ALL including sender
        console.log(`[chat] <${playerName}> ${text}`);
        break;
      }

      case 'player_action': {
        // Swing animation, damage, etc.
        broadcast({ type: 'player_action', id, action: msg.action }, ws);
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log(`[-] ${playerName} disconnected (id=${id})`);
    players.delete(id);
    broadcast({ type: 'player_leave', id }, null);
  });

  ws.on('error', (err) => {
    console.error(`[!] Error for ${playerName}:`, err.message);
  });
});

function broadcast(msg, exclude) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client !== exclude && client.readyState === 1) {
      client.send(data);
    }
  });
}

server.listen(PORT, () => {
  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║   Minecraft Clone — Multiplayer Server ║`);
  console.log(`  ╠═══════════════════════════════════════╣`);
  console.log(`  ║  Open http://localhost:${PORT}            ║`);
  console.log(`  ║  Share your IP for LAN multiplayer    ║`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);
});
