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

// In-memory maps
let onlineUsers = {};       // userId -> { userId, socketId, name, inGame, stats.. }
let activeGames = {};       // gameId -> { players[], board[], currentTurn, winner }
let pendingChallenges = {}; // challengedId -> { challengerId, challengedId, time }

// ===== TELEGRAM AUTH ENDPOINT =====
app.post('/auth', async (req, res) => {
  const userData = req.body;
  if (!userData.hash || !userData.id) {
    return res.status(400).send('Missing Telegram data');
  }

  // Validate via BOT_TOKEN
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return res.status(500).send('Server missing BOT_TOKEN');

  const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const checkString = Object.keys(userData)
    .filter(k => k !== 'hash')
    .sort()
    .map(k => `${k}=${userData[k]}`)
    .join('\n');
  const hmac = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  if (hmac !== userData.hash) {
    return res.status(403).send('Unauthorized: Invalid Telegram hash');
  }

  // Insert/update user in DB
  try {
    const sql = `
      INSERT INTO users (telegram_id, first_name, last_name, username, is_incognito)
      VALUES (?, ?, ?, ?, 0)
      ON DUPLICATE KEY UPDATE
        first_name = VALUES(first_name),
        last_name  = VALUES(last_name),
        username   = VALUES(username)
    `;
    await pool.query(sql, [
      userData.id,
      userData.first_name || '',
      userData.last_name  || '',
      userData.username   || ''
    ]);
    res.send('Telegram login success');
  } catch (err) {
    console.error('DB Insert Error:', err);
    res.status(500).send('DB error');
  }
});

// ===== INCOGNITO LOGIN =====
app.post('/incognito', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).send('Username required');

  try {
    const sql = `INSERT INTO users (incognito_name, is_incognito) VALUES (?, 1)`;
    const [result] = await pool.query(sql, [username]);
    const userId = result.insertId;
    res.json({ success: true, userId, username });
  } catch (err) {
    console.error('Incognito DB error:', err);
    res.status(500).send('Error creating incognito user');
  }
});

// Optional routes for your HTML:
app.get('/lobby', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lobby.html'));
});
app.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

// Memory for user stats is in DB, so we'll fetch from DB as needed

io.on('connection', (socket) => {
  console.log('New socket connection:', socket.id);

  // =========== JOIN LOBBY ===========
  socket.on('joinLobby', async ({ userId }) => {
    try {
      // Pull user from DB
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

      // Build a fallback name
      let displayName = '';
      if (user.is_incognito) {
        displayName = user.incognito_name || `Incognito#${user.id}`;
      } else {
        // Telegram fallback
        displayName = user.username ||
                      user.first_name ||
                      user.last_name ||
                      `TGUser#${user.id}`;
      }

      onlineUsers[user.id] = {
        userId: user.id,
        socketId: socket.id,
        name: displayName,
        inGame: false,
        gamesCount: user.games_count || 0,
        gamesWon:   user.games_won   || 0,
        gamesLost:  user.games_lost  || 0,
      };

      broadcastLobby();
    } catch (err) {
      console.error('Error in joinLobby:', err);
      socket.emit('errorMsg', 'Failed to join lobby');
    }
  });

  // =========== SEND CHALLENGE (Initial) ===========
  // The challenger is requesting a match with the challenged user
  socket.on('sendChallenge', ({ challengerId, challengedId }) => {
    console.log('sendChallenge from', challengerId, 'to', challengedId);

    // Make sure both are in onlineUsers
    if (!onlineUsers[challengerId] || !onlineUsers[challengedId]) {
      return socket.emit('errorMsg', 'User not found or offline.');
    }

    // If challenged is in game, can't challenge them
    if (onlineUsers[challengedId].inGame) {
      return socket.emit('errorMsg', 'That user is already in a game.');
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
      fromName: onlineUsers[challengerId].name,
    });
  });

  // =========== ACCEPT CHALLENGE ===========
  socket.on('acceptChallenge', ({ challengedId }) => {
    // Find the pending challenge
    const challenge = pendingChallenges[challengedId];
    if (!challenge) {
      return socket.emit('errorMsg', 'No challenge found to accept.');
    }
    const { challengerId } = challenge;
    console.log('User', challengedId, 'accepted challenge from', challengerId);

    // Clean up
    delete pendingChallenges[challengedId];

    // Create a new game
    const gameId = `game_${Date.now()}_${challengerId}_${challengedId}`;
    activeGames[gameId] = {
      players: [challengerId, challengedId],
      board: Array(9).fill(null),
      currentTurn: challengerId,
      winner: null
    };

    // Mark them as in game
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
    console.log('User', challengedId, 'refused challenge from', challengerId);

    // Notify the challenger
    if (onlineUsers[challengerId]) {
      io.to(onlineUsers[challengerId].socketId).emit('challengeRefused', {
        refusedBy: challengedId
      });
    }
  });

  // =========== MAKE MOVE ===========
  socket.on('makeMove', ({ gameId, userId, cellIndex }) => {
    console.log('makeMove from user', userId, 'cell', cellIndex, 'in game', gameId);

    const game = activeGames[gameId];
    if (!game) return;

    const [p1, p2] = game.players;
    // Check if it's the correct turn, etc.
    if (game.currentTurn !== userId || game.board[cellIndex] || game.winner) {
      return; // Invalid move
    }

    // 'X' or 'O'
    const mark = (userId === p1) ? 'X' : 'O';
    game.board[cellIndex] = mark;

    // Check winner
    const foundWinner = checkWinner(game.board);
    if (foundWinner) {
      game.winner = userId;
    } else if (game.board.every(c => c !== null)) {
      game.winner = 'tie'; // Full board no winner => tie
    } else {
      // Switch turns
      game.currentTurn = (game.currentTurn === p1) ? p2 : p1;
    }

    // Broadcast update to both players
    game.players.forEach((pid) => {
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
    console.log('quitGame from user', userId, 'in game', gameId);
    const game = activeGames[gameId];
    if (!game) return;

    if (!game.winner) {
      // Forfeit => the other player is winner
      const [p1, p2] = game.players;
      game.winner = (p1 == userId) ? p2 : p1;
    }
    endGame(gameId);
  });

  // Player disconnected => remove from online
  socket.on('disconnect', () => {
    const userEntry = Object.values(onlineUsers).find(u => u.socketId === socket.id);
    if (userEntry) {
      console.log('User disconnected:', userEntry.name, userEntry.userId);
      delete onlineUsers[userEntry.userId];
      broadcastLobby();
    }
  });
});

// End the game => update stats, emit 'gameEnded'
function endGame(gameId) {
  const game = activeGames[gameId];
  if (!game) return;

  const [p1, p2] = game.players;
  const winner = game.winner;

  // Update stats in DB
  Promise.all([
    updateStats(p1, winner),
    updateStats(p2, winner)
  ]).then(() => {
    game.players.forEach(pid => {
      if (onlineUsers[pid]) {
        onlineUsers[pid].inGame = false;
        io.to(onlineUsers[pid].socketId).emit('gameEnded', {
          winner: game.winner
        });
      }
    });
    delete activeGames[gameId];
    broadcastLobby();
  }).catch(err => console.error('Error updating stats:', err));
}

async function updateStats(userId, winner) {
  if (!onlineUsers[userId]) return;
  let isWinner = false, isTie = false;
  if (winner === 'tie') isTie = true;
  else if (String(winner) === String(userId)) isWinner = true;

  // If tie => just increment games_count
  // If winner => increment games_won
  // If loser => increment games_lost
  const lostFlag = (!isWinner && !isTie) ? 1 : 0;
  const sql = `
    UPDATE users
    SET games_count = games_count + 1,
        games_won   = games_won   + IF(?, 1, 0),
        games_lost  = games_lost  + IF(?, 1, 0)
    WHERE id = ? OR telegram_id = ?
  `;
  await pool.query(sql, [isWinner, lostFlag, userId, userId]);
}

// Return updated online players to everyone
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
