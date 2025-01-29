// server.js
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const path = require('path');
const dotenv = require('dotenv');
const { pool } = require('./db');

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static('public'));
app.use(bodyParser.json());

// In-memory objects
let onlineUsers = {};         // userId -> { userId, socketId, userName, inGame, stats... }
let activeGames = {};         // gameId -> { players:[p1, p2], board:[9], currentTurn, winner, replayVotes:{} }
let pendingChallenges = {};   // challengedId -> { challengerId, challengedId }

// ========== TELEGRAM AUTH ==========
app.post('/auth', async (req, res) => {
  const data = req.body; // { id, first_name, last_name, username, hash, etc. }
  if (!data.id || !data.hash) {
    return res.status(400).send('Missing Telegram data');
  }

  // Validate hash
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return res.status(500).send('No BOT_TOKEN set');

  const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const checkString = Object.keys(data)
    .filter(k => k !== 'hash')
    .sort()
    .map(k => `${k}=${data[k]}`)
    .join('\n');
  const hmac = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  if (hmac !== data.hash) {
    return res.status(403).send('Invalid Telegram hash');
  }

  // Insert or update user
  try {
    const userName = data.username || data.first_name || `TG#${data.id}`;
    const sql = `
      INSERT INTO users (telegram_id, user_name, is_incognito)
      VALUES (?, ?, 0)
      ON DUPLICATE KEY UPDATE
        user_name = VALUES(user_name)
    `;
    await pool.query(sql, [data.id, userName]);
    res.send('Telegram login success');
  } catch (err) {
    console.error('Telegram DB error:', err);
    res.status(500).send('DB error');
  }
});

// ========== INCOGNITO LOGIN ==========
app.post('/incognito', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).send('No username');

  try {
    const sql = `INSERT INTO users (user_name, is_incognito) VALUES (?, 1)`;
    const [result] = await pool.query(sql, [username]);
    const userId = result.insertId;
    res.json({ success: true, userId });
  } catch (err) {
    console.error('Incognito DB error:', err);
    res.status(500).send('Error creating incognito user');
  }
});

// ========== Serve Pages ==========
app.get('/lobby', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lobby.html'));
});
app.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

// ========== Socket.IO Logic ==========
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  // 1) Join Lobby
  socket.on('joinLobby', async ({ userId }) => {
    try {
      const [rows] = await pool.query(`
        SELECT id, telegram_id, user_name, is_incognito,
               games_count, games_won, games_lost
        FROM users
        WHERE id = ? OR telegram_id = ?
      `, [userId, userId]);

      if (!rows.length) {
        console.log('User not found in DB:', userId);
        return socket.emit('errorMsg', 'User not found');
      }
      const dbUser = rows[0];

      // Store in onlineUsers
      onlineUsers[dbUser.id] = {
        userId: dbUser.id,
        socketId: socket.id,
        userName: dbUser.user_name,
        inGame: false,
        gamesCount: dbUser.games_count || 0,
        gamesWon:   dbUser.games_won   || 0,
        gamesLost:  dbUser.games_lost  || 0
      };

      broadcastLobby();
    } catch (err) {
      console.error('joinLobby error:', err);
      socket.emit('errorMsg', 'Failed to join lobby');
    }
  });

  // 2) Send Challenge
  socket.on('sendChallenge', ({ challengerId, challengedId }) => {
    console.log(`sendChallenge from ${challengerId} to ${challengedId}`);
    if (!onlineUsers[challengerId] || !onlineUsers[challengedId]) {
      return socket.emit('errorMsg', 'User offline or not found');
    }
    if (onlineUsers[challengedId].inGame) {
      return socket.emit('errorMsg', 'That user is already in a game');
    }

    // Save challenge
    pendingChallenges[challengedId] = {
      challengerId,
      challengedId,
    };

    // Notify the challenged user
    io.to(onlineUsers[challengedId].socketId).emit('challengeReceived', {
      fromId: challengerId,
      fromName: onlineUsers[challengerId].userName
    });
  });

  // 3) Accept Challenge => create game
  socket.on('acceptChallenge', ({ challengedId }) => {
    const ch = pendingChallenges[challengedId];
    if (!ch) {
      return socket.emit('errorMsg', 'No challenge found to accept');
    }
    const { challengerId } = ch;
    delete pendingChallenges[challengedId];

    const gameId = `game_${Date.now()}_${challengerId}_${challengedId}`;
    activeGames[gameId] = {
      players: [challengerId, challengedId],
      board: Array(9).fill(null),
      currentTurn: challengerId,
      winner: null,
      replayVotes: {}
    };
    io.to(onlineUsers[challengerId].socketId).emit('gameStarted', { gameId, opponentId: challengedId });
    io.to(onlineUsers[challengedId].socketId).emit('gameStarted', { gameId, opponentId: challengerId });

    broadcastLobby();
  });
});
// server.js
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const path = require('path');
const dotenv = require('dotenv');
const { pool } = require('./db');

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static('public'));
app.use(bodyParser.json());

// Store active users and games
let onlineUsers = {};  
let pendingChallenges = {};  
let activeGames = {};  

// ========== TELEGRAM AUTH ==========
app.post('/auth', async (req, res) => {
  const data = req.body;
  if (!data.id || !data.hash) return res.status(400).send('Missing Telegram data');

  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return res.status(500).send('No BOT_TOKEN in .env');

  const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const checkString = Object.keys(data)
    .filter(k => k !== 'hash')
    .sort()
    .map(k => `${k}=${data[k]}`)
    .join('\n');
  const hmac = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');

  if (hmac !== data.hash) return res.status(403).send('Invalid Telegram hash');

  try {
    const userName = data.username || data.first_name || `TG#${data.id}`;
    const sql = `
      INSERT INTO users (telegram_id, user_name, is_incognito)
      VALUES (?, ?, 0)
      ON DUPLICATE KEY UPDATE user_name = VALUES(user_name)
    `;
    await pool.query(sql, [data.id, userName]);
    res.send('Telegram login success');
  } catch (err) {
    console.error('Telegram DB error:', err);
    res.status(500).send('DB error');
  }
});

// ========== INCOGNITO LOGIN ==========
app.post('/incognito', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).send('No username');

  try {
    const sql = `INSERT INTO users (user_name, is_incognito) VALUES (?, 1)`;
    const [result] = await pool.query(sql, [username]);
    const userId = result.insertId;
    res.json({ success: true, userId });
  } catch (err) {
    console.error('Incognito DB error:', err);
    res.status(500).send('Error creating incognito user');
  }
});

// ========== Socket.io Logic ==========
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  // Player joins lobby
  socket.on('joinLobby', async ({ userId }) => {
    try {
      const [rows] = await pool.query(`
        SELECT id, user_name, games_count, games_won, games_lost FROM users WHERE id = ?
      `, [userId]);

      if (!rows.length) return socket.emit('errorMsg', 'User not found');

      const user = rows[0];
      onlineUsers[userId] = {
        userId: user.id,
        socketId: socket.id,
        userName: user.user_name,
        inGame: false,
        gamesCount: user.games_count,
        gamesWon: user.games_won,
        gamesLost: user.games_lost
      };

      io.emit('onlinePlayers', Object.values(onlineUsers));
    } catch (err) {
      console.error('joinLobby error:', err);
      socket.emit('errorMsg', 'Failed to join lobby');
    }
  });

  // Send Challenge
  socket.on('sendChallenge', ({ challengerId, challengedId }) => {
    if (!onlineUsers[challengedId]) return socket.emit('errorMsg', 'User is offline');

    pendingChallenges[challengedId] = { challengerId, challengedId };
    io.to(onlineUsers[challengedId].socketId).emit('challengeReceived', {
      fromId: challengerId,
      fromName: onlineUsers[challengerId].userName
    });
  });

  // Accept Challenge
  socket.on('acceptChallenge', ({ challengedId }) => {
    const ch = pendingChallenges[challengedId];
    if (!ch) return socket.emit('errorMsg', 'No challenge found');

    delete pendingChallenges[challengedId];

    const gameId = `game_${Date.now()}_${ch.challengerId}_${ch.challengedId}`;
    activeGames[gameId] = {
      players: [ch.challengerId, ch.challengedId],
      board: Array(9).fill(null),
      currentTurn: ch.challengerId,
      winner: null
    };

    io.to(onlineUsers[ch.challengerId].socketId).emit('gameStarted', { gameId, opponentId: challengedId });
    io.to(onlineUsers[ch.challengedId].socketId).emit('gameStarted', { gameId, opponentId: ch.challengerId });

    onlineUsers[ch.challengerId].inGame = true;
    onlineUsers[ch.challengedId].inGame = true;

    io.emit('onlinePlayers', Object.values(onlineUsers));
  });

  // Make Move
  socket.on('makeMove', ({ gameId, userId, cellIndex }) => {
    const game = activeGames[gameId];
    if (!game || game.currentTurn !== userId || game.board[cellIndex]) return;

    game.board[cellIndex] = userId === game.players[0] ? 'X' : 'O';
    game.currentTurn = game.players.find(pid => pid !== userId);

    io.to(onlineUsers[game.players[0]].socketId).emit('updateGame', game);
    io.to(onlineUsers[game.players[1]].socketId).emit('updateGame', game);
  });

  socket.on('quitGame', ({ gameId, userId }) => {
    delete activeGames[gameId];
    io.emit('onlinePlayers', Object.values(onlineUsers));
  });
});

httpServer.listen(8080, () => console.log('Server running on port 8080'));
