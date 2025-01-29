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

app.use(express.static('public')); // Serve static files
app.use(bodyParser.json());

// Store active users, challenges, and games
let onlineUsers = {}; 
let pendingChallenges = {}; 
let activeGames = {}; 

// ========== TELEGRAM AUTH ==========
app.post('/auth', async (req, res) => {
    const data = req.body;
    if (!data.id || !data.hash) return res.status(400).send('Missing Telegram data');

    const BOT_TOKEN = process.env.BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).send('No BOT_TOKEN in .env');

    // Validate Telegram login
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

// Serve static pages
app.get('/lobby', (req, res) => res.sendFile(path.join(__dirname, 'public', 'lobby.html')));
app.get('/game', (req, res) => res.sendFile(path.join(__dirname, 'public', 'game.html')));

// ========== SOCKET.IO EVENTS ==========
io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    // Player joins lobby
    socket.on('joinLobby', async ({ userId }) => {
        try {
            const [rows] = await pool.query(`SELECT id, user_name, games_count, games_won, games_lost FROM users WHERE id = ?`, [userId]);

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

    // ========== CHALLENGE SYSTEM ==========
    socket.on('sendChallenge', ({ challengerId, challengedId }) => {
        if (!onlineUsers[challengedId]) return socket.emit('errorMsg', 'User is offline');

        if (!pendingChallenges[challengedId]) {
            pendingChallenges[challengedId] = [];
        }
        pendingChallenges[challengedId].push({ challengerId, challengedId });

        io.to(onlineUsers[challengedId].socketId).emit('challengeReceived', {
            fromId: challengerId,
            fromName: onlineUsers[challengerId].userName
        });

        console.log(`Challenge sent: ${challengerId} -> ${challengedId}`);
    });

    socket.on('acceptChallenge', ({ challengedId }) => {
        if (!pendingChallenges[challengedId] || pendingChallenges[challengedId].length === 0) {
            return socket.emit('errorMsg', 'No challenge found');
        }

        const challenge = pendingChallenges[challengedId].shift();
        const { challengerId } = challenge;

        const gameId = `game_${Date.now()}_${challengerId}_${challengedId}`;
        activeGames[gameId] = {
            players: [challengerId, challengedId],
            board: Array(9).fill(null),
            currentTurn: challengerId,
            winner: null
        };

        io.to(onlineUsers[challengerId].socketId).emit('gameStarted', { gameId, opponentId: challengedId });
        io.to(onlineUsers[challengedId].socketId).emit('gameStarted', { gameId, opponentId: challengerId });

        onlineUsers[challengerId].inGame = true;
        onlineUsers[challengedId].inGame = true;

        io.emit('onlinePlayers', Object.values(onlineUsers));

        console.log(`Game started: ${challengerId} vs ${challengedId}`);
    });

    // ========== GAME LOGIC ==========
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

    socket.on('requestReplay', ({ gameId, userId }) => {
        const game = activeGames[gameId];
        if (!game) return;

        game.replayVotes = game.replayVotes || {};
        game.replayVotes[userId] = true;

        if (game.replayVotes[game.players[0]] && game.replayVotes[game.players[1]]) {
            game.board = Array(9).fill(null);
            game.winner = null;
            game.currentTurn = game.players[0];
            io.to(onlineUsers[game.players[0]].socketId).emit('updateGame', game);
            io.to(onlineUsers[game.players[1]].socketId).emit('updateGame', game);
        }
    });

    // ========== HANDLE DISCONNECT ==========
    socket.on('disconnect', () => {
        const userId = Object.keys(onlineUsers).find(id => onlineUsers[id].socketId === socket.id);
        if (userId) {
            delete onlineUsers[userId];
            io.emit('onlinePlayers', Object.values(onlineUsers));
        }
    });
});

const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
