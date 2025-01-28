// server.js
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const dotenv = require('dotenv');
const path = require('path');
const { pool } = require('./db');

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(bodyParser.json());
app.use(express.static('public')); // Serve index.html, lobby.html, game.html, etc. from /public

// ========== TELEGRAM AUTH (POST /auth) ==========
app.post('/auth', async (req, res) => {
  const userData = req.body; // { id, first_name, last_name, username, hash, auth_date, ... }
  if (!userData.hash || !userData.id) {
    return res.status(400).send('Missing Telegram data');
  }

  // 1. Validate Telegram-supplied hash to ensure data is from Telegram
  const secretKey = crypto.createHash('sha256').update(process.env.BOT_TOKEN).digest();
  const checkString = Object.keys(userData)
    .filter((key) => key !== 'hash')
    .sort()
    .map((key) => `${key}=${userData[key]}`)
    .join('\n');
  const hmac = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  if (hmac !== userData.hash) {
    return res.status(403).send('Unauthorized: Invalid Telegram hash');
  }

  // 2. Store user in DB (upsert)
  try {
    const sql = `
      INSERT INTO users (telegram_id, first_name, last_name, username, is_incognito)
      VALUES (?, ?, ?, ?, 0)
      ON DUPLICATE KEY UPDATE
        first_name = VALUES(first_name),
        last_name = VALUES(last_name),
        username = VALUES(username)
    `;
    await pool.query(sql, [userData.id, userData.first_name, userData.last_name, userData.username]);
    // Send success message
    res.send('Telegram login success');
  } catch (err) {
    console.error('DB Insert Error:', err);
    res.status(500).send('DB error');
  }
});

// ========== INCOGNITO LOGIN (POST /incognito) ==========
app.post('/incognito', async (req, res) => {
  const { username } = req.body;
  if (!username) {
    return res.status(400).send('Username required');
  }

  // 1. Store incognito user in DB
  try {
    const sql = `INSERT INTO users (incognito_name, is_incognito) VALUES (?, 1)`;
    const [result] = await pool.query(sql, [username]);
    const userId = result.insertId; // newly created row ID
    res.json({ success: true, userId, username });
  } catch (err) {
    console.error('Incognito DB error:', err);
    res.status(500).send('Error creating incognito user');
  }
});

// ========== SERVE LOBBY / GAME PAGES =========
// (Optional if you're directly using public/lobby.html, etc.)
app.get('/lobby', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lobby.html'));
});
app.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

// ========== REAL-TIME LOGIC WITH SOCKET.IO ==========
let onlineUsers = {};  // userId -> { username, socketId, inGame, ... }
let activeGames = {};  // gameId -> { players, boardState, currentTurn, ... }

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // 1. User Joins Lobby
  socket.on('joinLobby', async ({ userId }) => {
    try {
      // Fetch user from DB to determine username
      const [rows] = await pool.query(
        `SELECT id, telegram_id, first_name, last_name, username, incognito_name, is_incognito
         FROM users
         WHERE id = ? OR telegram_id = ?`,
        [userId, userId] // We'll try matching either ID or telegram_id
      );

      if (!rows.length) {
        console.log('User not found in DB');
        return socket.emit('errorMsg', 'User not found');
      }

      const user = rows[0];
      const displayName = user.is_incognito
        ? user.incognito_name
        : user.username || user.first_name || `User${user.id}`;

      // Mark user as online
      onlineUsers[user.id] = {
        userId: user.id,
        displayName,
        socketId: socket.id,
        inGame: false
      };

      console.log(`User joined lobby: ${displayName} (ID: ${user.id})`);
      // Notify all clients of updated online list
      io.emit('onlinePlayers', Object.values(onlineUsers));
    } catch (err) {
      console.error('Error joining lobby:', err);
      socket.emit('errorMsg', 'Failed to join lobby');
    }
  });

  // 2. Challenge Another Player
  socket.on('challengePlayer', ({ challengerId, challengedId }) => {
    // create a new game or something
    if (!onlineUsers[challengerId] || !onlineUsers[challengedId]) return;
    // Basic example: create a unique gameId
    const gameId = `game_${Date.now()}_${challengerId}_${challengedId}`;

    activeGames[gameId] = {
      players: [challengerId, challengedId],
      board: Array(9).fill(null),   // 3x3 tic-tac-toe in a 1D array
      currentTurn: challengerId,
      winner: null,
    };

    // Mark them inGame
    onlineUsers[challengerId].inGame = true;
    onlineUsers[challengedId].inGame = true;

    // Notify both players to move to /game?gameId=xxx
    io.to(onlineUsers[challengerId].socketId).emit('gameStarted', { gameId, opponentId: challengedId });
    io.to(onlineUsers[challengedId].socketId).emit('gameStarted', { gameId, opponentId: challengerId });

    // Refresh the lobby for everyone else
    io.emit('onlinePlayers', Object.values(onlineUsers));
  });

  // 3. Handle a Move
  socket.on('makeMove', ({ gameId, userId, cellIndex }) => {
    const game = activeGames[gameId];
    if (!game) return;

    // Check if it's user's turn
    if (game.currentTurn !== userId) {
      return socket.emit('errorMsg', 'Not your turn!');
    }

    // If cell is already taken or game over, ignore
    if (game.board[cellIndex] || game.winner) return;

    // Mark cell with userId (X or O in a real scenario).
    const [player1, player2] = game.players;
    const mark = userId === player1 ? 'X' : 'O';
    game.board[cellIndex] = mark;

    // Check for winner or tie
    const winner = checkWinner(game.board);
    if (winner) {
      game.winner = userId;
    } else if (game.board.every((c) => c !== null)) {
      game.winner = 'tie';
    }

    // Switch turns if no winner
    if (!game.winner) {
      game.currentTurn = userId === player1 ? player2 : player1;
    }

    // Broadcast updated game state to both players
    for (const pid of game.players) {
      io.to(onlineUsers[pid].socketId).emit('updateGame', {
        gameId,
        board: game.board,
        currentTurn: game.currentTurn,
        winner: game.winner,
      });
    }
  });

  // 4. Quit or Replay
  socket.on('quitGame', ({ gameId, userId }) => {
    const game = activeGames[gameId];
    if (!game) return;
    // The user who quits forfeits if game isn't finished
    if (!game.winner) {
      game.winner = game.players.find((p) => p !== userId); // other player wins
    }
    endGame(gameId);
  });

  // 5. On Disconnect
  socket.on('disconnect', () => {
    // Find which user disconnected
    const userEntry = Object.values(onlineUsers).find((u) => u.socketId === socket.id);
    if (userEntry) {
      console.log(`User disconnected: ${userEntry.displayName}`);
      // If user was in a game, handle that
      // ...
      delete onlineUsers[userEntry.userId];
      io.emit('onlinePlayers', Object.values(onlineUsers));
    }
  });
});

// Helper function: End Game
function endGame(gameId) {
  const game = activeGames[gameId];
  if (!game) return;
  // Mark players as not inGame
  game.players.forEach((pid) => {
    if (onlineUsers[pid]) {
      onlineUsers[pid].inGame = false;
      io.to(onlineUsers[pid].socketId).emit('gameEnded', { gameId, winner: game.winner });
    }
  });
  delete activeGames[gameId];
  io.emit('onlinePlayers', Object.values(onlineUsers));
}

// Helper function: Check Winner
function checkWinner(board) {
  const wins = [
    [0,1,2],[3,4,5],[6,7,8], // rows
    [0,3,6],[1,4,7],[2,5,8], // cols
    [0,4,8],[2,4,6]          // diagonals
  ];
  for (const [a,b,c] of wins) {
    if (board[a] && board[a] === board[b] && board[b] === board[c]) {
      return board[a]; // 'X' or 'O'
    }
  }
  return null;
}

// Start the server
const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
