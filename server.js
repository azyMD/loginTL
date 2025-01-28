// server.js
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const path = require('path');
const dotenv = require('dotenv');
const { pool } = require('./db');  // db.js with .env-based credentials

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static('public'));
app.use(bodyParser.json());

// ========== TELEGRAM AUTH (POST /auth) ==========
app.post('/auth', async (req, res) => {
  const userData = req.body; // { id, first_name, last_name, username, hash, ... }
  if (!userData.hash || !userData.id) {
    return res.status(400).send('Missing Telegram data');
  }

  // Validate via BOT_TOKEN from .env
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return res.status(500).send('Server missing BOT_TOKEN');

  const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const checkString = Object.keys(userData)
    .filter((k) => k !== 'hash')
    .sort()
    .map((k) => `${k}=${userData[k]}`)
    .join('\n');

  const hmac = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  if (hmac !== userData.hash) {
    return res.status(403).send('Unauthorized: Invalid Telegram hash');
  }

  // Insert/update user, ensuring is_incognito = 0
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
      userData.last_name || '', 
      userData.username || ''
    ]);
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

// Optional routes for lobby/game HTML
app.get('/lobby', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lobby.html'));
});
app.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

// ========== REAL-TIME (Socket.IO) ==========

// Memory structures
let onlineUsers = {};   // userId -> { userId, displayName, socketId, inGame }
let activeGames = {};   // gameId -> { players, board, currentTurn, winner }

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // 1. Join Lobby
  socket.on('joinLobby', async ({ userId }) => {
    try {
      const [rows] = await pool.query(`
        SELECT id, telegram_id, first_name, last_name, username,
               incognito_name, is_incognito, games_count, games_won, games_lost
        FROM users
        WHERE id = ? OR telegram_id = ?
      `, [userId, userId]);
      
      if (!rows.length) {
        console.log('User not found in DB');
        return socket.emit('errorMsg', 'User not found');
      }

      const user = rows[0];
      const displayName = user.is_incognito
        ? user.incognito_name
        : (user.username || user.first_name || `User${user.id}`);

      onlineUsers[user.id] = {
        userId: user.id,
        displayName,
        socketId: socket.id,
        inGame: false,
        gamesCount: user.games_count,
        gamesWon: user.games_won,
        gamesLost: user.games_lost,
      };

      console.log(`User joined lobby: ${displayName} (#${user.id})`);
      broadcastLobby();
    } catch (err) {
      console.error('Error joining lobby:', err);
      socket.emit('errorMsg', 'Failed to join lobby');
    }
  });

  // 2. Challenge Another Player => create a new game
  socket.on('challengePlayer', ({ challengerId, challengedId }) => {
    if (!onlineUsers[challengerId] || !onlineUsers[challengedId]) return;

    const gameId = `game_${Date.now()}_${challengerId}_${challengedId}`;
    activeGames[gameId] = {
      players: [challengerId, challengedId],
      board: Array(9).fill(null),
      currentTurn: challengerId,
      winner: null
    };

    onlineUsers[challengerId].inGame = true;
    onlineUsers[challengedId].inGame = true;

    io.to(onlineUsers[challengerId].socketId).emit('gameStarted', {
      gameId, opponentId: challengedId
    });
    io.to(onlineUsers[challengedId].socketId).emit('gameStarted', {
      gameId, opponentId: challengerId
    });

    broadcastLobby();
  });

  // 3. Make a Move => update the board & check winner
  socket.on('makeMove', ({ gameId, userId, cellIndex }) => {
    const game = activeGames[gameId];
    if (!game) return;

    // 3a. Validate
    if (game.currentTurn !== userId || game.board[cellIndex] || game.winner) {
      return; 
    }
    // 3b. Assign 'X' or 'O'
    const [p1, p2] = game.players;
    const mark = (userId === p1) ? 'X' : 'O';
    game.board[cellIndex] = mark;

    // 3c. Check winner
    const foundWinner = checkWinner(game.board);
    if (foundWinner) {
      game.winner = userId;
    } else if (game.board.every(c => c !== null)) {
      game.winner = 'tie';
    } else {
      game.currentTurn = (game.currentTurn === p1) ? p2 : p1;
    }

    // 3d. Broadcast
    game.players.forEach(pid => {
      io.to(onlineUsers[pid].socketId).emit('updateGame', {
        gameId,
        board: game.board,
        currentTurn: game.currentTurn,
        winner: game.winner
      });
    });
  });

  // 4. Quit => forfeit or end game
  socket.on('quitGame', ({ gameId, userId }) => {
    const game = activeGames[gameId];
    if (!game) return;
    if (!game.winner) {
      // The player who quits loses
      game.winner = game.players.find(p => p !== userId);
    }
    endGame(gameId);
  });

  // 5. Disconnect => remove from onlineUsers
  socket.on('disconnect', () => {
    const userEntry = Object.values(onlineUsers).find(u => u.socketId === socket.id);
    if (userEntry) {
      console.log(`User disconnected: ${userEntry.displayName}`);
      delete onlineUsers[userEntry.userId];
      broadcastLobby();
    }
  });
});

// End game => update DB for each player’s stats
function endGame(gameId) {
  const game = activeGames[gameId];
  if (!game) return;
  const [p1, p2] = game.players;
  const winner = game.winner;

  Promise.all([
    updateStats(p1, winner),
    updateStats(p2, winner)
  ])
  .then(() => {
    game.players.forEach(pid => {
      if (onlineUsers[pid]) {
        onlineUsers[pid].inGame = false;
        io.to(onlineUsers[pid].socketId).emit('gameEnded', {
          gameId,
          winner
        });
      }
    });
    delete activeGames[gameId];
    broadcastLobby(); 
  })
  .catch(err => console.error('Error updating stats:', err));
}

// Update each player's games_count/won/lost
async function updateStats(userId, winner) {
  // If tie => increment games_count for both
  // If winner => increment games_won for winner, games_lost for other
  let isWinner = false, isTie = false;
  if (winner === 'tie') {
    isTie = true;
  } else if (Number(userId) === Number(winner)) {
    isWinner = true;
  }

  const sql = `
    UPDATE users
    SET games_count = games_count + 1,
        games_won   = games_won   + IF(?, 1, 0),
        games_lost  = games_lost  + IF(?, 1, 0)
    WHERE id = ? OR telegram_id = ?
  `;
  // isWinner => increment won, isTie => neither, else => increment lost
  const lostFlag = (!isWinner && !isTie) ? 1 : 0;
  
  await pool.query(sql, [isWinner, lostFlag, userId, userId]);
}

// Re-broadcast the updated lobby
function broadcastLobby() {
  const usersArray = Object.values(onlineUsers).map(u => ({
    userId: u.userId,
    displayName: u.displayName,
    inGame: u.inGame,
    gamesCount: u.gamesCount,
    gamesWon: u.gamesWon,
    gamesLost: u.gamesLost
  }));
  io.emit('onlinePlayers', usersArray);
}

// Basic TicTacToe check
function checkWinner(board) {
  const lines = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6]
  ];
  for (const [a,b,c] of lines) {
    if (board[a] && board[a] === board[b] && board[b] === board[c]) {
      return board[a]; 
    }
  }
  return null;
}

const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
