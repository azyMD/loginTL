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

// In-memory data
let onlineUsers = {};         // userId -> { userId, socketId, name, inGame, stats... }
let activeGames = {};         // gameId -> { players:[p1,p2], board:[...], currentTurn, winner, replayVotes:{} }
let pendingChallenges = {};   // challengedId -> { challengerId, challengedId, time }

// ========== TELEGRAM AUTH (Sets incognito_name = username) ==========
app.post('/auth', async (req, res) => {
  const user = req.body; // { id, first_name, last_name, username, hash, ... }
  if (!user.id || !user.hash) {
    return res.status(400).send('Missing Telegram data');
  }
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return res.status(500).send('No BOT_TOKEN in .env');

  // Validate hash
  const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const checkString = Object.keys(user)
    .filter(k => k !== 'hash')
    .sort()
    .map(k => `${k}=${user[k]}`)
    .join('\n');

  const hmac = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  if (hmac !== user.hash) {
    return res.status(403).send('Unauthorized: Invalid Telegram hash');
  }

  // Insert/update user => incognito_name = username so never null
  try {
    const incogName = user.username || user.first_name || `TGUser#${user.id}`;
    const sql = `
      INSERT INTO users (telegram_id, first_name, last_name, username, incognito_name, is_incognito)
      VALUES (?, ?, ?, ?, ?, 0)
      ON DUPLICATE KEY UPDATE
        first_name = VALUES(first_name),
        last_name  = VALUES(last_name),
        username   = VALUES(username),
        incognito_name = VALUES(incognito_name)
    `;
    await pool.query(sql, [
      user.id,
      user.first_name || '',
      user.last_name  || '',
      user.username   || '',
      incogName
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
  if (!username) return res.status(400).send('Missing username');

  try {
    const sql = `INSERT INTO users (incognito_name, is_incognito) VALUES (?, 1)`;
    const [result] = await pool.query(sql, [username]);
    const userId = result.insertId;
    res.json({ success: true, userId });
  } catch (err) {
    console.error('Incognito DB error:', err);
    res.status(500).send('Error creating incognito user');
  }
});

// Serve static pages if needed
app.get('/lobby', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lobby.html'));
});
app.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

// ========== Socket.io Logic ==========

io.on('connection', (socket) => {
  console.log('New socket:', socket.id);

  // 1) Join lobby => fetch user from DB, store in onlineUsers
  socket.on('joinLobby', async ({ userId }) => {
    try {
      const [rows] = await pool.query(`
        SELECT id, telegram_id, incognito_name, is_incognito,
               games_count, games_won, games_lost
        FROM users
        WHERE id = ? OR telegram_id = ?
      `, [userId, userId]);

      if (!rows.length) {
        console.log('User not found in DB:', userId);
        return socket.emit('errorMsg', 'User not found');
      }
      const dbUser = rows[0];

      let name = dbUser.incognito_name || `User#${dbUser.id}`;

      onlineUsers[dbUser.id] = {
        userId: dbUser.id,
        socketId: socket.id,
        name,
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

  // 2) Send Challenge => store pending challenge
  socket.on('sendChallenge', ({ challengerId, challengedId }) => {
    console.log(`sendChallenge from ${challengerId} to ${challengedId}`);
    if (!onlineUsers[challengerId] || !onlineUsers[challengedId]) {
      return socket.emit('errorMsg', 'User offline or not found');
    }
    if (onlineUsers[challengedId].inGame) {
      return socket.emit('errorMsg', 'That user is already in a game');
    }
    // Store pending
    pendingChallenges[challengedId] = {
      challengerId,
      challengedId,
      time: Date.now()
    };
    // Notify challenged user
    io.to(onlineUsers[challengedId].socketId).emit('challengeReceived', {
      fromId: challengerId,
      fromName: onlineUsers[challengerId].name
    });
  });

  // 3) Accept Challenge => create a new game
  socket.on('acceptChallenge', ({ challengedId }) => {
    const challenge = pendingChallenges[challengedId];
    if (!challenge) {
      return socket.emit('errorMsg', 'No challenge found to accept');
    }
    const { challengerId } = challenge;
    delete pendingChallenges[challengedId];

    const gameId = `game_${Date.now()}_${challengerId}_${challengedId}`;
    activeGames[gameId] = {
      players: [challengerId, challengedId],
      board: Array(9).fill(null),
      currentTurn: challengerId,
      winner: null,
      replayVotes: {}
    };
    if (onlineUsers[challengerId]) onlineUsers[challengerId].inGame = true;
    if (onlineUsers[challengedId]) onlineUsers[challengedId].inGame = true;

    console.log('Challenge accepted => new game:', gameId);

    // Notify both
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

  // 4) Refuse Challenge
  socket.on('refuseChallenge', ({ challengedId }) => {
    const ch = pendingChallenges[challengedId];
    if (!ch) return;
    delete pendingChallenges[challengedId];
    const { challengerId } = ch;
    console.log(`User ${challengedId} refused challenge from ${challengerId}`);
    if (onlineUsers[challengerId]) {
      io.to(onlineUsers[challengerId].socketId).emit('challengeRefused', {
        refusedBy: challengedId
      });
    }
  });

  // 5) Make Move => Enforce turn logic
  socket.on('makeMove', ({ gameId, userId, cellIndex }) => {
    console.log(`makeMove user ${userId}, cell ${cellIndex}, game ${gameId}`);
    const game = activeGames[gameId];
    if (!game) return; // no game

    // Must be your turn, cell must be empty, no winner
    if (game.currentTurn !== userId || game.board[cellIndex] || game.winner) {
      return; // ignore invalid
    }
    const [p1, p2] = game.players;
    const mark = (String(userId) === String(p1)) ? 'X' : 'O';
    game.board[cellIndex] = mark;

    // Check winner
    const foundWinnerMark = checkWinner(game.board);
    if (foundWinnerMark) {
      const winnerUserId = (foundWinnerMark === 'X') ? p1 : p2;
      game.winner = winnerUserId;
    } else if (game.board.every(c => c !== null)) {
      game.winner = 'tie';
    } else {
      // switch turn
      game.currentTurn = (String(game.currentTurn) === String(p1)) ? p2 : p1;
    }

    // Update both
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

  // 6) Quit => Forfeit
  socket.on('quitGame', ({ gameId, userId }) => {
    console.log(`quitGame from user ${userId} in game ${gameId}`);
    const game = activeGames[gameId];
    if (!game) return;
    if (!game.winner) {
      const [p1, p2] = game.players;
      game.winner = (String(p1) === String(userId)) ? p2 : p1;
    }
    endGame(gameId);
  });

  // 7) Replay => each user must also accept
  socket.on('requestReplay', ({ gameId, userId }) => {
    console.log(`requestReplay from ${userId} in game ${gameId}`);
    const game = activeGames[gameId];
    if (!game) return;

    // Mark that userId wants a replay
    game.replayVotes[userId] = true;

    // If both players want replay => reset
    const [p1, p2] = game.players;
    if (game.replayVotes[p1] && game.replayVotes[p2]) {
      // Reset board
      game.board = Array(9).fill(null);
      game.winner = null;
      // Keep same currentTurn
      game.replayVotes = {};
      console.log('Both players accepted replay => board reset');

      // Notify updateGame
      game.players.forEach(pid => {
        if (onlineUsers[pid]) {
          io.to(onlineUsers[pid].socketId).emit('updateGame', {
            board: game.board,
            currentTurn: game.currentTurn,
            winner: game.winner
          });
        }
      });
    } else {
      // The other user sees a prompt
      const other = (String(userId) === String(p1)) ? p2 : p1;
      if (onlineUsers[other]) {
        io.to(onlineUsers[other].socketId).emit('replayRequested', {
          fromUser: userId
        });
      }
    }
  });

  // The other user can confirm => do the same
  socket.on('acceptReplay', ({ gameId, userId }) => {
    console.log(`acceptReplay from ${userId} in game ${gameId}`);
    const game = activeGames[gameId];
    if (!game) return;

    // Mark user acceptance
    game.replayVotes[userId] = true;
    const [p1, p2] = game.players;

    // If both in => reset
    if (game.replayVotes[p1] && game.replayVotes[p2]) {
      game.board = Array(9).fill(null);
      game.winner = null;
      game.replayVotes = {};
      console.log('Replay reset after both accepted');

      game.players.forEach(pid => {
        if (onlineUsers[pid]) {
          io.to(onlineUsers[pid].socketId).emit('updateGame', {
            board: game.board,
            currentTurn: game.currentTurn,
            winner: game.winner
          });
        }
      });
    }
  });

  socket.on('refuseReplay', ({ gameId, userId }) => {
    const game = activeGames[gameId];
    if (!game) return;
    console.log(`User ${userId} refused replay => do nothing special`);
    // Could notify the other user
    const [p1, p2] = game.players;
    const other = (String(p1) === String(userId)) ? p2 : p1;
    if (onlineUsers[other]) {
      io.to(onlineUsers[other].socketId).emit('replayRefused', { byUser: userId });
    }
    // Clear replayVotes
    game.replayVotes = {};
  });

  // Disconnect => remove from online
  socket.on('disconnect', () => {
    const userEntry = Object.values(onlineUsers).find(u => u.socketId === socket.id);
    if (userEntry) {
      console.log('User disconnected:', userEntry.name, userEntry.userId);
      delete onlineUsers[userEntry.userId];
      broadcastLobby();
    }
  });
});

// End the game => update DB stats => gameEnded
function endGame(gameId) {
  const game = activeGames[gameId];
  if (!game) return;
  const [p1, p2] = game.players;
  const winner = game.winner;

  Promise.all([
    updateStats(p1, winner),
    updateStats(p2, winner)
  ]).then(() => {
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
  let isTie = (winner === 'tie');
  let isWinner = (String(userId) === String(winner));
  // Lost if not winner + not tie
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

// Re-broadcast lobby
function broadcastLobby() {
  const arr = Object.values(onlineUsers).map(u => ({
    userId: u.userId,
    displayName: u.name,
    inGame: u.inGame,
    gamesCount: u.gamesCount,
    gamesWon:   u.gamesWon,
    gamesLost:  u.gamesLost
  }));
  io.emit('onlinePlayers', arr);
}

// Check TTT winner => returns 'X','O' or null
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
  console.log(`Server on port ${PORT}`);
});
