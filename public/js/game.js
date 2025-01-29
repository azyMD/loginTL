// public/js/game.js
const socket = io();

const params = new URLSearchParams(window.location.search);
const gameId = params.get('gameId');
const userId = params.get('userId');
const opponentId = params.get('opponentId');

const statusEl = document.getElementById('status');
const boardEl = document.getElementById('board');
const replayBtn = document.getElementById('replay-btn');
const quitBtn = document.getElementById('quit-btn');

// Create board
for (let i = 0; i < 9; i++) {
  const cell = document.createElement('div');
  cell.dataset.index = i;
  cell.addEventListener('click', () => {
    socket.emit('makeMove', { gameId, userId, cellIndex: i });
  });
  boardEl.appendChild(cell);
}

// Update board
socket.on('updateGame', ({ board, currentTurn, winner }) => {
  renderBoard(board);
  renderStatus(currentTurn, winner);
});
