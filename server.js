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

/** In-memory maps */
let onlineUsers = {};         // userId -> { userId, socketId, name, inGame, gamesCount, gamesWon, gamesLost }
let activeGames = {};         // gameId -> { players:[], board:[], currentTurn, winner }
let pendingChallenges = {};   // challengedId -> { challengerId, challengedId, time }

// ========== TELEGRAM AUTH: sets incognito_name = userData.username so no NULL name. ==========
app.post('/auth', async (req, res) => {
  const userData = req.body; // { id, first_name, last_name, username, hash, ... }
  if (!userData.id || !userData.hash) {
    return res.status(400).send('Missing Telegram data');
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return res.status(500).send('Server missing BOT_TOKEN');

  // Validate hash
  const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const checkString = Object.keys(userData)
    .filter(k => k !== 'hash')
    .sort()
    .map(k => `${k}=${userData[k]}`)
    .join('\n');
  const hmac = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  if (hmac !== userData.hash) {
    return res.status(403).send('Unauthorized: invalid telegram hash');
  }

  // Insert or update user
  try {
    const sql = `
      INSERT INTO users (
        telegram_id, first_name, last_name, username,
        incognito_name, is_incognito
      )
      VALUES (?, ?, ?, ?, ?, 0)
      ON DUPLICATE KEY UPDATE
        first_name = VALUES(first_name),
        last_name  = VALUES(last_name),
        username   = VALUES(username),
        incognito_name = VALUES(incognito_name)
    `;
    const incogName = userData.username || userData.first_name || `TGUser#${userData.id}`;
    await pool.query(sql, [
      userData.id,
      userData.first_name || '',
      userData.last_name  || '',
      userData.username   || '',
      incogName           // ensure telegram player also has incognito_name
    ]);

    res.send('Telegram login success');
  } catch (err) {
    console.error('DB Insert Error:', err);
    res.status(500).send('DB error');
  }
});

// ========== INCOGNITO LOGIN ==========
app.post('/incognito', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).send('Username required');

  try {
    const sql = `
      INSERT INTO users (incognito_name, is_incognito)
      VALUES (?, 1)
    `;
    const [result] = await pool.query(sql, [username]);
    const userId = result.insertId;
    res.json({ success: true, userId, username });
  } catch (err) {
    console.error('Incognito DB error:', err);
    res.status(500).send('Error creating incognito user');
  }
});

// Serve lobby/game if needed
app.get('/lobby', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lobby.html'));
});
app.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

// Memory + Socket events

io.on('connection', (socket) => {
  console.log('New socket connected:', socket.id);

  // =========== JOIN LOBBY ===========
  socket.on('joinLobby', async ({ userId }) => {
    try {
      const [rows] = await pool.query(`
        SELECT id, telegram_id, first_name, last_name, username,
               incognito_name, is_incognito, games_count, games_won, games_lost
        FROM users
        WHERE id = ? OR telegram_id = ?
      `, [userId, userId]);

      if (!rows.length) {
        console.log('User not found in DB for userId:', userId);
        return socket.emit('errorMsg', 'User not found');
      }
      const user = rows[0];

      // Build fallback name from incognito_name
      // Because incognito_name now holds the username if Telegram user
      let displayName = user.incognito_name ||
                        user.username ||
                        user.first_name ||
                        `User#${user.id}`;

      onlineUsers[user.id] = {
        userId: user.id,
        socketId: socket.id,
        name: displayName,
        inGame: false,
        gamesCount: user.games_count || 0,
        gamesWon:   user.games_won   || 0,
        gamesLost:  user.games_lost  || 0
      };

      console.log('User joined lobby:', displayName, '(ID:', user.id, ')');
      broadcastLobby();
    } catch (err) {
      console.error('joinLobby error:', err);
      socket.emit('errorMsg', 'Failed to join lobby');
    }
  });

  // =========== SEND CHALLENGE ===========
  socket.on('sendChallenge', ({ challengerId, challengedId }) => {
    console.log(`sendChallenge from ${challengerId} to ${challengedId}`);

    // Validate both users
    if (!onlineUsers[challengerId] || !onlineUsers[challengedId]) {
      return socket.emit('errorMsg', 'User is offline or not found.');
    }
    if (onlineUsers[challengedId].inGame) {
      return socket.emit('errorMsg', 'That user is currently in a game.');
    }

    // Store a pending challenge
    pendingChallenges[challengedId] = {
      challengerId,
      challengedId,
      time: Date.now()
    };

    // Notify the challenged user
    io.to(onlineUsers[challengedId].socketId).emit('challengeReceived', {
      fromId: challengerId,
      fromName: onlineUsers[challengerId].name
    });
  });

  // =========== ACCEPT CHALLENGE ===========
  socket.on('acceptChallenge', ({ challengedId }) => {
    // Retrieve the pending challenge
    const challenge = pendingChallenges[challengedId];
    if (!challenge) {
      return socket.emit('errorMsg', 'No challenge found to accept.');
    }
    const { challengerId } = challenge;
    delete pendingChallenges[challengedId];

    console.log('User', challengedId, 'accepted challenge from', challengerId);

    // Create a new game
    const gameId = `game_${Date.now()}_${challengerId}_${challengedId}`;
    activeGames[gameId] = {
      players: [challengerId, challengedId],
      board: Array(9).fill(null),
      currentTurn: challengerId,
      winner: null
    };

    // Mark them inGame
    if (onlineUsers[challengerId]) onlineUsers[challengerId].inGame = true;
    if (onlineUsers[challengedId]) onlineUsers[challengedId].inGame = true;

    // Emit gameStarted to both
    if (onlineUsers[challengerId]) {
      io.to(onlineUsers[challengerId].socketId).emit('gameStarted', {
        gameId,
        opponentId: challengedId
      });
    }
    if (onlineUsers[challengedId]) {
      io.to(onlineUsers[challengedId].socketId).emit('gameStarted', {
        gameId,
        opponentId: challengerId
      });
    }
    broadcastLobby();
  });

  // =========== REFUSE CHALLENGE ===========
  socket.on('refuseChallenge', ({ challengedId }) => {
    const challenge = pendingChallenges[challengedId];
    if (!challenge) return;
    const { challengerId } = challenge;
    delete pendingChallenges[challengedId];

    console.log(`User ${challengedId} refused challenge from ${challengerId}`);
    // Notify challenger
    if (onlineUsers[challengerId]) {
      io.to(onlineUsers[challengerId].socketId).emit('challengeRefused', {
        refusedBy: challengedId
      });
    }
  });

  // =========== MAKE MOVE ===========
  socket.on('makeMove', ({ gameId, userId, cellIndex }) => {
    console.log(`makeMove from user ${userId} cell ${cellIndex} in game ${gameId}`);

    const game = activeGames[gameId];
    if (!game) return;

    // Validate turn, empty cell, no winner
    if (game.currentTurn !== userId || game.board[cellIndex] || game.winner) {
      return; // do nothing if it's not your turn or cell is used
    }

    const [p1, p2] = game.players;
    const mark = (userId == p1) ? 'X' : 'O';
    game.board[cellIndex] = mark;

    // Check for winner
    const winnerMark = checkWinner(game.board);
    if (winnerMark) {
      // translate 'X' / 'O' back to p1/p2
      game.winner = (winnerMark === 'X') ? p1 : p2;
    } else if (game.board.every(c => c !== null)) {
      game.winner = 'tie';
    } else {
      // Switch turn
      game.currentTurn = (userId == p1) ? p2 : p1;
    }

    // Send update to both
    game.players.forEach(pid => {
      if (onlineUsers[pid]) {
        io.to(onlineUsers[pid].socketId).emit('updateGame', {
          board: game.board,
          currentTurn: game.currentTurn,
          winner: game.winner
        });
      }
    });
  });

  // =========== QUIT GAME ===========
  socket.on('quitGame', ({ gameId, userId }) => {
    console.log(`quitGame from user ${userId} in game ${gameId}`);
    const game = activeGames[gameId];
    if (!game) return;

    if (!game.winner) {
      // Forfeit => other player is winner
      const [p1, p2] = game.players;
      game.winner = (p1 == userId) ? p2 : p1;
    }
    endGame(gameId);
  });

  // =========== DISCONNECT ===========
  socket.on('disconnect', () => {
    const userEntry = Object.values(onlineUsers).find(u => u.socketId === socket.id);
    if (userEntry) {
      console.log('User disconnected:', userEntry.name, userEntry.userId);
      delete onlineUsers[userEntry.userId];
      broadcastLobby();
    }
  });
});

// Finish the game => update stats, broadcast "gameEnded"
function endGame(gameId) {
  const game = activeGames[gameId];
  if (!game) return;
  const [p1, p2] = game.players;
  const winner = game.winner;

  Promise.all([
    updateStats(p1, winner),
    updateStats(p2, winner)
  ]).then(() => {
    // Notify both
    game.players.forEach(pid => {
      if (onlineUsers[pid]) {
        onlineUsers[pid].inGame = false;
        io.to(onlineUsers[pid].socketId).emit('gameEnded', { winner });
      }
    });
    delete activeGames[gameId];
    broadcastLobby();
  }).catch(err => console.error('endGame stats error:', err));
}

async function updateStats(userId, winner) {
  if (!onlineUsers[userId]) return;
  let isTie = (winner === 'tie');
  let isWinner = (String(userId) === String(winner));

  const lostFlag = (!isWinner && !isTie) ? 1 : 0;
  const sql = `
    UPDATE users
    SET games_count = games_count + 1,
        games_won   = games_won + IF(?, 1, 0),
        games_lost  = games_lost+ IF(?, 1, 0)
    WHERE id = ? OR telegram_id = ?
  `;
  await pool.query(sql, [isWinner, lostFlag, userId, userId]);
}

// Return updated info to everyone
function broadcastLobby() {
  const playerArray = Object.values(onlineUsers).map(u => ({
    userId: u.userId,
    displayName: u.name,
    inGame: u.inGame,
    gamesCount: u.gamesCount,
    gamesWon:   u.gamesWon,
    gamesLost:  u.gamesLost
  }));
  io.emit('onlinePlayers', playerArray);
}

// TTT winner check => returns 'X' or 'O' or null
function checkWinner(board) {
  const lines = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6]
  ];
  for (const [a,b,c] of lines) {
    if (board[a] && board[a] === board[b] && board[b] === board[c]) {
      return board[a]; // 'X' or 'O'
    }
  }
  return null;
}

const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
