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

app.use(express.static('public')); // Serve static from "public" folder
app.use(bodyParser.json());

// In-memory objects
let onlineUsers = {};         // userId -> { userId, socketId, userName, inGame, gamesCount, gamesWon, gamesLost }
let activeGames = {};         // gameId -> { players:[p1, p2], board:[9], currentTurn, winner, replayVotes:{} }
let pendingChallenges = {};   // challengedId -> { challengerId, challengedId }

// ========== TELEGRAM AUTH ==========
app.post('/auth', async (req, res) => {
  const data = req.body; // { id, first_name, last_name, username, hash, etc. }
  if (!data.id || !data.hash) {
    return res.status(400).send('Missing Telegram data');
  }

  // Validate hash
  const BOT_TOKEN = process.env.BOT_TOKEN; // e.g. "1234:ABC..."
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

  // Insert or update user => user_name from data.username or fallback
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

// ========== Serve Lobby and Game HTML (Optional) ==========
app.get('/lobby', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lobby.html'));
});
app.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

// ========== Socket.io Events ==========
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  // 1) Join Lobby
  socket.on('joinLobby', async ({ userId }) => {
    try {
      // Load user from DB
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

  // 2) Send Challenge => store pending challenge
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
      currentTurn: challengerId, // challenger goes first
      winner: null,
      replayVotes: {}
    };
    if (onlineUsers[challengerId]) onlineUsers[challengerId].inGame = true;
    if (onlineUsers[challengedId]) onlineUsers[challengedId].inGame = true;

    console.log('Challenge accepted => game', gameId);

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

  // 4) Refuse
  socket.on('refuseChallenge', ({ challengedId }) => {
    const ch = pendingChallenges[challengedId];
    if (!ch) return;
    delete pendingChallenges[challengedId];

    const { challengerId } = ch;
    console.log(`User ${challengedId} refused challenge from ${challengerId}`);
    // Notify challenger
    if (onlineUsers[challengerId]) {
      io.to(onlineUsers[challengerId].socketId).emit('challengeRefused', {
        refusedBy: challengedId
      });
    }
  });

  // 5) Make Move => turn-based
  socket.on('makeMove', ({ gameId, userId, cellIndex }) => {
    console.log(`makeMove from user ${userId}, cell ${cellIndex}, game ${gameId}`);
    const game = activeGames[gameId];
    if (!game) return;

    // Must be your turn, cell not used, no winner
    if (String(game.currentTurn) !== String(userId) || game.board[cellIndex] || game.winner) {
      return; // ignore invalid
    }

    const [p1, p2] = game.players;
    const mark = (String(userId) === String(p1)) ? 'X' : 'O';
    game.board[cellIndex] = mark;

    // Check winner
    const wMark = checkWinner(game.board);
    if (wMark) {
      game.winner = (wMark === 'X') ? p1 : p2;
    } else if (game.board.every(c => c !== null)) {
      game.winner = 'tie';
    } else {
      // Switch turn
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

  // 6) Quit => forfeit
  socket.on('quitGame', ({ gameId, userId }) => {
    console.log(`quitGame from user ${userId}, game ${gameId}`);
    const game = activeGames[gameId];
    if (!game) return;

    if (!game.winner) {
      // The other wins
      const [p1, p2] = game.players;
      game.winner = (String(p1) === String(userId)) ? p2 : p1;
    }
    endGame(gameId);
  });

  // 7) Replay => both must accept => reset
  socket.on('requestReplay', ({ gameId, userId }) => {
    console.log(`requestReplay from ${userId} in ${gameId}`);
    const game = activeGames[gameId];
    if (!game) return;

    // Mark user vote
    game.replayVotes[userId] = true;

    const [p1, p2] = game.players;
    const other = (String(userId) === String(p1)) ? p2 : p1;

    // If the other has also voted => reset
    if (game.replayVotes[p1] && game.replayVotes[p2]) {
      console.log('Both accepted replay => reset board');
      game.board = Array(9).fill(null);
      game.winner = null;
      // keep currentTurn as is
      game.replayVotes = {};
      // Update
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
      // Ask the other user
      if (onlineUsers[other]) {
        io.to(onlineUsers[other].socketId).emit('replayRequested', {
          fromUser: userId
        });
      }
    }
  });

  socket.on('acceptReplay', ({ gameId, userId }) => {
    console.log(`acceptReplay from ${userId} in ${gameId}`);
    const game = activeGames[gameId];
    if (!game) return;

    game.replayVotes[userId] = true;
    const [p1, p2] = game.players;
    if (game.replayVotes[p1] && game.replayVotes[p2]) {
      // Reset
      console.log('Both accepted replay => reset board');
      game.board = Array(9).fill(null);
      game.winner = null;
      game.replayVotes = {};
      // Update
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
    console.log(`refuseReplay from ${userId} game ${gameId}`);
    const game = activeGames[gameId];
    if (!game) return;
    game.replayVotes = {};
    // Let the other user know
    const [p1, p2] = game.players;
    const other = (String(userId) === String(p1)) ? p2 : p1;
    if (onlineUsers[other]) {
      io.to(onlineUsers[other].socketId).emit('replayRefused', { byUser: userId });
    }
  });

  // 8) Disconnect
  socket.on('disconnect', () => {
    const usr = Object.values(onlineUsers).find(u => u.socketId === socket.id);
    if (usr) {
      console.log('User disconnected:', usr.userName, usr.userId);
      delete onlineUsers[usr.userId];
      broadcastLobby();
    }
  });
});

// endGame => update stats => gameEnded
function endGame(gameId) {
  const game = activeGames[gameId];
  if (!game) return;
  const [p1, p2] = game.players;
  const winner = game.winner;

  Promise.all([
    updateStats(p1, winner),
    updateStats(p2, winner)
  ]).then(() => {
    game.players.forEach(uid => {
      if (onlineUsers[uid]) {
        onlineUsers[uid].inGame = false;
        io.to(onlineUsers[uid].socketId).emit('gameEnded', { winner });
      }
    });
    delete activeGames[gameId];
    broadcastLobby();
  }).catch(err => console.error('endGame error:', err));
}

async function updateStats(userId, winner) {
  if (!onlineUsers[userId]) return;
  let isTie = (winner === 'tie');
  let isWinner = (String(userId) === String(winner));
  const lostFlag = (!isWinner && !isTie) ? 1 : 0;

  const sql = `
    UPDATE users
    SET games_count = games_count + 1,
        games_won   = games_won + IF(?,1,0),
        games_lost  = games_lost+ IF(?,1,0)
    WHERE id = ? OR telegram_id = ?
  `;
  await pool.query(sql, [isWinner, lostFlag, userId, userId]);
}

function broadcastLobby() {
  const arr = Object.values(onlineUsers).map(u => ({
    userId: u.userId,
    displayName: u.userName,
    inGame: u.inGame,
    gamesCount: u.gamesCount,
    gamesWon:   u.gamesWon,
    gamesLost:  u.gamesLost
  }));
  io.emit('onlinePlayers', arr);
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

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
