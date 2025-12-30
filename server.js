const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Game state storage
const games = new Map();        // gameId -> GameState
const players = new Map();      // odId -> PlayerInfo
const queues = { dice: [], rps: [] };  // Matchmaking queues
const leaderboard = new Map();  // odId -> { odId, name, wins, losses, score }

// Helper functions
const generateId = () => Math.random().toString(36).substr(2, 9);
const rollDice = () => Math.floor(Math.random() * 6) + 1;
const getAIMove = () => ['rock', 'paper', 'scissors'][Math.floor(Math.random() * 3)];

const getRPSResult = (p1, p2) => {
  if (p1 === p2) return 'tie';
  const wins = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
  return wins[p1] === p2 ? 'p1' : 'p2';
};

// Create a new game
function createGame(type, player1, player2, isAI = false) {
  const game = {
    id: generateId(),
    type,
    player1: { odId: player1.odId, name: player1.name, score: 0, move: null },
    player2: { odId: player2.odId, name: player2.name, score: 0, move: null, isAI },
    status: 'playing',
    round: 1,
    createdAt: Date.now()
  };
  games.set(game.id, game);
  return game;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);
  
  // Register player
  socket.on('register', (data) => {
    const player = {
      odId: socket.id,
      name: data.name || `Player_${socket.id.slice(0, 4)}`,
      currentGame: null
    };
    players.set(socket.id, player);
    
    // Init leaderboard entry
    if (!leaderboard.has(socket.id)) {
      leaderboard.set(socket.id, { odId: socket.id, name: player.name, wins: 0, losses: 0, score: 0 });
    }
    
    socket.emit('registered', { 
      playerId: socket.id, 
      name: player.name,
      leaderboard: getTopPlayers(10)
    });
    console.log(`Player registered: ${player.name}`);
  });

  // Join matchmaking queue
  socket.on('join_queue', (data) => {
    const { gameType } = data;
    const player = players.get(socket.id);
    if (!player) return;

    // Check if already in queue
    if (queues[gameType]?.includes(socket.id)) {
      socket.emit('error', { message: 'Already in queue' });
      return;
    }

    // Add to queue
    queues[gameType].push(socket.id);
    socket.emit('queued', { gameType, position: queues[gameType].length });
    console.log(`${player.name} joined ${gameType} queue. Queue size: ${queues[gameType].length}`);

    // Try to match
    if (queues[gameType].length >= 2) {
      const p1Id = queues[gameType].shift();
      const p2Id = queues[gameType].shift();
      
      const p1 = players.get(p1Id);
      const p2 = players.get(p2Id);
      
      if (p1 && p2) {
        const game = createGame(gameType, p1, p2);
        p1.currentGame = game.id;
        p2.currentGame = game.id;

        // Join socket room
        io.sockets.sockets.get(p1Id)?.join(game.id);
        io.sockets.sockets.get(p2Id)?.join(game.id);

        // Notify both players
        io.to(p1Id).emit('game_start', {
          gameId: game.id,
          gameType,
          you: { name: p1.name, score: 0 },
          opponent: { name: p2.name, score: 0, isAI: false }
        });
        
        io.to(p2Id).emit('game_start', {
          gameId: game.id,
          gameType,
          you: { name: p2.name, score: 0 },
          opponent: { name: p1.name, score: 0, isAI: false }
        });

        console.log(`Match created: ${p1.name} vs ${p2.name} (${gameType})`);
      }
    }
  });

  // Leave queue
  socket.on('leave_queue', (data) => {
    const { gameType } = data;
    queues[gameType] = queues[gameType].filter(id => id !== socket.id);
    socket.emit('left_queue', { gameType });
  });

  // Play against AI
  socket.on('play_ai', (data) => {
    const { gameType } = data;
    const player = players.get(socket.id);
    if (!player) return;

    const aiPlayer = { odId: 'AI', name: 'AI Opponent' };
    const game = createGame(gameType, player, aiPlayer, true);
    player.currentGame = game.id;

    socket.join(game.id);
    socket.emit('game_start', {
      gameId: game.id,
      gameType,
      you: { name: player.name, score: 0 },
      opponent: { name: 'AI Opponent', score: 0, isAI: true }
    });

    console.log(`${player.name} started ${gameType} vs AI`);
  });

  // Make a move
  socket.on('move', (data) => {
    const { gameId, move } = data;
    const game = games.get(gameId);
    const player = players.get(socket.id);
    
    if (!game || !player || game.status !== 'playing') {
      socket.emit('error', { message: 'Invalid game state' });
      return;
    }

    // Determine if this player is player1 or player2
    const isPlayer1 = game.player1.odId === socket.id;
    const currentPlayer = isPlayer1 ? game.player1 : game.player2;
    const opponent = isPlayer1 ? game.player2 : game.player1;

    // Record the move
    currentPlayer.move = move;

    // If playing against AI, generate AI move immediately
    if (opponent.isAI) {
      if (game.type === 'dice') {
        opponent.move = 'roll'; // AI always rolls
      } else if (game.type === 'rps') {
        opponent.move = getAIMove();
      }
    }

    // Check if both players have moved
    if (currentPlayer.move && opponent.move) {
      let result = processRound(game);
      
      // Send result to player
      socket.emit('round_result', {
        round: game.round - 1,
        yourMove: result.isPlayer1 ? result.p1Move : result.p2Move,
        opponentMove: result.isPlayer1 ? result.p2Move : result.p1Move,
        result: result.isPlayer1 ? result.p1Result : result.p2Result,
        scores: {
          you: isPlayer1 ? game.player1.score : game.player2.score,
          opponent: isPlayer1 ? game.player2.score : game.player1.score
        }
      });

      // If not AI, send to opponent too
      if (!opponent.isAI) {
        io.to(opponent.odId).emit('round_result', {
          round: game.round - 1,
          yourMove: !result.isPlayer1 ? result.p1Move : result.p2Move,
          opponentMove: !result.isPlayer1 ? result.p2Move : result.p1Move,
          result: !isPlayer1 ? result.p1Result : result.p2Result,
          scores: {
            you: !isPlayer1 ? game.player1.score : game.player2.score,
            opponent: !isPlayer1 ? game.player2.score : game.player1.score
          }
        });
      }

      // Reset moves for next round
      game.player1.move = null;
      game.player2.move = null;
    } else if (!opponent.isAI) {
      // Waiting for opponent
      socket.emit('waiting', { message: 'Waiting for opponent...' });
      io.to(opponent.odId).emit('opponent_moved', { message: 'Opponent has made their move!' });
    }
  });

  // Leave game
  socket.on('leave_game', () => {
    const player = players.get(socket.id);
    if (!player || !player.currentGame) return;

    const game = games.get(player.currentGame);
    if (game) {
      const opponent = game.player1.odId === socket.id ? game.player2 : game.player1;
      
      if (!opponent.isAI) {
        io.to(opponent.odId).emit('opponent_left', { message: 'Opponent left the game' });
        // Award win to remaining player
        updateLeaderboard(opponent.odId, true);
        updateLeaderboard(socket.id, false);
      }
      
      game.status = 'ended';
      socket.leave(game.id);
    }
    
    player.currentGame = null;
    socket.emit('left_game');
  });

  // Get leaderboard
  socket.on('get_leaderboard', () => {
    socket.emit('leaderboard', { players: getTopPlayers(10) });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const player = players.get(socket.id);
    if (player) {
      // Remove from queues
      Object.keys(queues).forEach(type => {
        queues[type] = queues[type].filter(id => id !== socket.id);
      });
      
      // Handle active game
      if (player.currentGame) {
        const game = games.get(player.currentGame);
        if (game && game.status === 'playing') {
          const opponent = game.player1.odId === socket.id ? game.player2 : game.player1;
          if (!opponent.isAI) {
            io.to(opponent.odId).emit('opponent_left', { message: 'Opponent disconnected' });
          }
          game.status = 'ended';
        }
      }
      
      players.delete(socket.id);
    }
    console.log(`Player disconnected: ${socket.id}`);
  });
});

// Process a round and determine winner
function processRound(game) {
  const p1Move = game.player1.move;
  const p2Move = game.player2.move;
  let p1Result, p2Result, p1Display, p2Display;

  if (game.type === 'dice') {
    const p1Roll = rollDice();
    const p2Roll = rollDice();
    p1Display = p1Roll;
    p2Display = p2Roll;
    
    if (p1Roll > p2Roll) {
      p1Result = 'win'; p2Result = 'lose';
      game.player1.score += 10;
    } else if (p1Roll < p2Roll) {
      p1Result = 'lose'; p2Result = 'win';
      game.player2.score += 10;
    } else {
      p1Result = 'tie'; p2Result = 'tie';
    }
  } else if (game.type === 'rps') {
    p1Display = p1Move;
    p2Display = p2Move;
    const result = getRPSResult(p1Move, p2Move);
    
    if (result === 'p1') {
      p1Result = 'win'; p2Result = 'lose';
      game.player1.score += 15;
    } else if (result === 'p2') {
      p1Result = 'lose'; p2Result = 'win';
      game.player2.score += 15;
    } else {
      p1Result = 'tie'; p2Result = 'tie';
    }
  }

  game.round++;
  
  // Update leaderboard for non-AI games
  if (!game.player2.isAI && p1Result !== 'tie') {
    updateLeaderboard(game.player1.odId, p1Result === 'win');
    updateLeaderboard(game.player2.odId, p2Result === 'win');
  }

  return { p1Move: p1Display, p2Move: p2Display, p1Result, p2Result, isPlayer1: true };
}

function updateLeaderboard(odId, won) {
  const entry = leaderboard.get(odId);
  if (entry) {
    if (won) {
      entry.wins++;
      entry.score += 10;
    } else {
      entry.losses++;
    }
  }
}

function getTopPlayers(limit) {
  return Array.from(leaderboard.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// REST endpoints
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/leaderboard', (req, res) => res.json(getTopPlayers(10)));
app.get('/api/stats', (req, res) => res.json({
  online: players.size,
  games: games.size,
  queues: { dice: queues.dice.length, rps: queues.rps.length }
}));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🎮 ACE Arena server running on http://localhost:${PORT}`);
});