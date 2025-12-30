import { useEffect, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

const SERVER_URL = 'http://localhost:3001';

type GameType = 'dice' | 'rps';
type GameStatus = 'idle' | 'queued' | 'playing';
type RoundResult = 'win' | 'lose' | 'tie';

interface GameState {
  gameId: string | null;
  gameType: GameType | null;
  you: { name: string; score: number };
  opponent: { name: string; score: number; isAI: boolean };
}

interface RoundData {
  yourMove: string | number;
  opponentMove: string | number;
  result: RoundResult;
}

interface LeaderboardEntry {
  odId: string;
  name: string;
  wins: number;
  losses: number;
  score: number;
}

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [playerName, setPlayerName] = useState('');
  const [registered, setRegistered] = useState(false);
  
  const [status, setStatus] = useState<GameStatus>('idle');
  const [game, setGame] = useState<GameState | null>(null);
  const [lastRound, setLastRound] = useState<RoundData | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [opponentMoved, setOpponentMoved] = useState(false);
  
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [logs, setLogs] = useState<string[]>([]);

  const addLog = useCallback((msg: string) => {
    setLogs(prev => [...prev.slice(-29), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  // Connect to server
  useEffect(() => {
    const newSocket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
    
    newSocket.on('connect', () => {
      setConnected(true);
      addLog('Connected to server');
    });
    
    newSocket.on('disconnect', () => {
      setConnected(false);
      setRegistered(false);
      addLog('Disconnected from server');
    });

    newSocket.on('registered', (data) => {
      setPlayerId(data.playerId);
      setRegistered(true);
      setLeaderboard(data.leaderboard || []);
      addLog(`Registered as ${data.name}`);
    });

    newSocket.on('queued', (data) => {
      setStatus('queued');
      addLog(`Joined ${data.gameType} queue (position: ${data.position})`);
    });

    newSocket.on('game_start', (data) => {
      setStatus('playing');
      setGame({
        gameId: data.gameId,
        gameType: data.gameType,
        you: data.you,
        opponent: data.opponent
      });
      setLastRound(null);
      setWaiting(false);
      addLog(`Game started! You vs ${data.opponent.name}${data.opponent.isAI ? ' (AI)' : ''}`);
    });

    newSocket.on('waiting', () => {
      setWaiting(true);
    });

    newSocket.on('opponent_moved', () => {
      setOpponentMoved(true);
      addLog('Opponent made their move!');
    });

    newSocket.on('round_result', (data) => {
      setLastRound(data);
      setWaiting(false);
      setOpponentMoved(false);
      setGame(prev => prev ? {
        ...prev,
        you: { ...prev.you, score: data.scores.you },
        opponent: { ...prev.opponent, score: data.scores.opponent }
      } : null);
      
      const resultText = data.result === 'win' ? '🎉 You win!' : data.result === 'lose' ? '😢 You lose' : '🤝 Tie';
      addLog(`Round: ${data.yourMove} vs ${data.opponentMove} - ${resultText}`);
    });

    newSocket.on('opponent_left', (data) => {
      addLog(data.message);
      setStatus('idle');
      setGame(null);
    });

    newSocket.on('left_game', () => {
      setStatus('idle');
      setGame(null);
      addLog('Left game');
    });

    newSocket.on('leaderboard', (data) => {
      setLeaderboard(data.players);
    });

    newSocket.on('error', (data) => {
      addLog(`Error: ${data.message}`);
    });

    setSocket(newSocket);
    return () => { newSocket.close(); };
  }, [addLog]);

  const register = () => {
    if (socket && playerName.trim()) {
      socket.emit('register', { name: playerName.trim() });
    }
  };

  const joinQueue = (gameType: GameType) => {
    socket?.emit('join_queue', { gameType });
  };

  const playAI = (gameType: GameType) => {
    socket?.emit('play_ai', { gameType });
  };

  const makeMove = (move: string) => {
    if (game?.gameId) {
      socket?.emit('move', { gameId: game.gameId, move });
      setWaiting(true);
    }
  };

  const leaveGame = () => {
    socket?.emit('leave_game');
  };

  const leaveQueue = () => {
    if (game?.gameType) {
      socket?.emit('leave_queue', { gameType: game.gameType });
    }
    setStatus('idle');
  };

  // Dice component
  const DiceFace = ({ value, rolling }: { value: number; rolling?: boolean }) => {
    const pos: Record<number, [number, number][]> = {
      1: [[1,1]], 2: [[0,2],[2,0]], 3: [[0,2],[1,1],[2,0]],
      4: [[0,0],[0,2],[2,0],[2,2]], 5: [[0,0],[0,2],[1,1],[2,0],[2,2]],
      6: [[0,0],[0,2],[1,0],[1,2],[2,0],[2,2]]
    };
    return (
      <div className={`w-16 h-16 bg-neutral-800 rounded-xl border border-neutral-700 grid grid-cols-3 p-2 ${rolling ? 'animate-pulse' : ''}`}>
        {[0,1,2].map(r => [0,1,2].map(c => (
          <div key={`${r}${c}`} className="flex items-center justify-center">
            {pos[value]?.some(([pr,pc]) => pr === r && pc === c) && <div className="w-2 h-2 rounded-full bg-emerald-400" />}
          </div>
        )))}
      </div>
    );
  };

  const resultColor = { win: 'text-emerald-400', lose: 'text-red-400', tie: 'text-neutral-400' };

  // Not registered yet
  if (!registered) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center p-4">
        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-8 w-full max-w-sm">
          <h1 className="text-2xl font-semibold mb-2">ACE Arena</h1>
          <p className="text-neutral-500 text-sm mb-6">Real-time Multiplayer Games</p>
          
          <div className="space-y-4">
            <div>
              <label className="text-sm text-neutral-400 block mb-1">Your Name</label>
              <input
                type="text"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && register()}
                placeholder="Enter your name"
                className="w-full px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg focus:outline-none focus:border-emerald-500"
              />
            </div>
            <button
              onClick={register}
              disabled={!connected || !playerName.trim()}
              className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-700 disabled:text-neutral-500 rounded-lg font-medium transition"
            >
              {connected ? 'Enter Arena' : 'Connecting...'}
            </button>
          </div>
          
          <div className="mt-4 flex items-center gap-2 text-xs">
            <div className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-500'}`} />
            <span className="text-neutral-500">{connected ? 'Connected' : 'Disconnected'}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-4">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <header className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold">ACE Arena</h1>
            <p className="text-xs text-neutral-500">Playing as {playerName}</p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-neutral-400">Online</span>
          </div>
        </header>

        <div className="grid grid-cols-3 gap-4">
          {/* Main Game Area */}
          <div className="col-span-2 space-y-4">
            {/* Game Selection / Queue / Playing */}
            {status === 'idle' && (
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
                <h2 className="font-medium mb-4">Select Game</h2>
                <div className="grid grid-cols-2 gap-3">
                  {(['dice', 'rps'] as GameType[]).map(type => (
                    <div key={type} className="space-y-2">
                      <button
                        onClick={() => joinQueue(type)}
                        className="w-full p-4 bg-neutral-800 hover:bg-neutral-750 border border-neutral-700 rounded-xl transition"
                      >
                        <div className="text-2xl mb-1">{type === 'dice' ? '🎲' : '✊'}</div>
                        <div className="font-medium">{type === 'dice' ? 'Dice Duel' : 'RPS Battle'}</div>
                        <div className="text-xs text-neutral-500">Find opponent</div>
                      </button>
                      <button
                        onClick={() => playAI(type)}
                        className="w-full py-2 text-sm text-neutral-400 hover:text-white transition"
                      >
                        Play vs AI
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {status === 'queued' && (
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 text-center">
                <div className="animate-spin w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full mx-auto mb-4" />
                <h2 className="font-medium">Finding Opponent...</h2>
                <p className="text-sm text-neutral-500 mt-1">Waiting in queue</p>
                <button onClick={leaveQueue} className="mt-4 text-sm text-neutral-400 hover:text-white">
                  Cancel
                </button>
              </div>
            )}

            {status === 'playing' && game && (
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
                {/* Score header */}
                <div className="flex items-center justify-between mb-6">
                  <div className="text-center">
                    <div className="text-xs text-neutral-500">You</div>
                    <div className="text-2xl font-bold text-emerald-400">{game.you.score}</div>
                  </div>
                  <div className="text-neutral-600">vs</div>
                  <div className="text-center">
                    <div className="text-xs text-neutral-500">{game.opponent.name}</div>
                    <div className="text-2xl font-bold text-red-400">{game.opponent.score}</div>
                  </div>
                </div>

                {/* Last round result */}
                {lastRound && (
                  <div className="text-center mb-6 p-4 bg-neutral-800/50 rounded-lg">
                    <div className="flex items-center justify-center gap-6 mb-2">
                      {game.gameType === 'dice' ? (
                        <>
                          <DiceFace value={lastRound.yourMove as number} />
                          <span className="text-neutral-600">vs</span>
                          <DiceFace value={lastRound.opponentMove as number} />
                        </>
                      ) : (
                        <>
                          <div className="text-4xl">{lastRound.yourMove === 'rock' ? '✊' : lastRound.yourMove === 'paper' ? '✋' : '✌️'}</div>
                          <span className="text-neutral-600">vs</span>
                          <div className="text-4xl">{lastRound.opponentMove === 'rock' ? '✊' : lastRound.opponentMove === 'paper' ? '✋' : '✌️'}</div>
                        </>
                      )}
                    </div>
                    <div className={`font-medium ${resultColor[lastRound.result]}`}>
                      {lastRound.result === 'win' ? 'You Win!' : lastRound.result === 'lose' ? 'You Lose' : 'Tie!'}
                    </div>
                  </div>
                )}

                {/* Game controls */}
                <div className="text-center">
                  {waiting ? (
                    <div className="text-neutral-500">
                      <div className="animate-pulse">Waiting for {game.opponent.isAI ? 'AI' : 'opponent'}...</div>
                    </div>
                  ) : (
                    <>
                      {opponentMoved && !game.opponent.isAI && (
                        <div className="text-emerald-400 text-sm mb-3">Opponent is ready!</div>
                      )}
                      {game.gameType === 'dice' ? (
                        <button
                          onClick={() => makeMove('roll')}
                          className="px-8 py-3 bg-amber-600 hover:bg-amber-500 rounded-full font-medium transition"
                        >
                          🎲 Roll Dice
                        </button>
                      ) : (
                        <div className="flex justify-center gap-3">
                          {['rock', 'paper', 'scissors'].map(move => (
                            <button
                              key={move}
                              onClick={() => makeMove(move)}
                              className="px-5 py-3 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-xl transition"
                            >
                              {move === 'rock' ? '✊' : move === 'paper' ? '✋' : '✌️'}
                              <div className="text-xs mt-1 capitalize">{move}</div>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>

                <button onClick={leaveGame} className="mt-6 w-full py-2 text-sm text-neutral-500 hover:text-white transition">
                  Leave Game
                </button>
              </div>
            )}

            {/* Activity Log */}
            <div className="bg-neutral-900/50 border border-neutral-800 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                <span className="text-xs text-neutral-500 uppercase tracking-wide">Activity Log</span>
              </div>
              <div className="h-32 overflow-y-auto space-y-1 text-xs font-mono text-neutral-400">
                {logs.map((log, i) => <div key={i}>{log}</div>)}
              </div>
            </div>
          </div>

          {/* Leaderboard */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
            <h3 className="font-medium mb-3 flex items-center gap-2">
              <span>🏆</span> Leaderboard
            </h3>
            <div className="space-y-2">
              {leaderboard.slice(0, 8).map((player, i) => (
                <div key={player.odId} className={`flex items-center gap-2 p-2 rounded-lg ${player.odId === playerId ? 'bg-emerald-500/10 border border-emerald-500/30' : 'bg-neutral-800/50'}`}>
                  <span className="w-5 text-center text-xs text-neutral-500">{i + 1}</span>
                  <span className="flex-1 truncate text-sm">{player.name}</span>
                  <span className="text-sm font-medium text-emerald-400">{player.score}</span>
                </div>
              ))}
              {leaderboard.length === 0 && (
                <div className="text-sm text-neutral-500 text-center py-4">No players yet</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}