import React, { useState, useEffect, useRef } from 'react';
import { Users, Coins, X, Shield, Eye, EyeOff } from 'lucide-react';

// Note: In a real React app, you'd install socket.io-client with: npm install socket.io-client
// For this demo, we'll load it from CDN via a script tag
const CoupGame = () => {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [gameState, setGameState] = useState('menu'); // menu, lobby, playing, ended
  const [roomCode, setRoomCode] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [players, setPlayers] = useState([]);
  const [myPlayerId, setMyPlayerId] = useState(null);
  const [currentPlayerId, setCurrentPlayerId] = useState(null);
  const [actionInProgress, setActionInProgress] = useState(null);
  const [gameLog, setGameLog] = useState([]);
  const [error, setError] = useState('');
  const [selectedTarget, setSelectedTarget] = useState(null);
  const socketRef = useRef(null);

  const ACTIONS = {
    income: { name: 'Income', coins: 1, blockable: false, challengeable: false },
    foreignAid: { name: 'Foreign Aid', coins: 2, blockable: true, blocker: 'Duke', challengeable: false },
    tax: { name: 'Tax', coins: 3, blockable: false, challengeable: true, card: 'Duke' },
    assassinate: { name: 'Assassinate', cost: 3, blockable: true, blocker: 'Contessa', challengeable: true, card: 'Assassin' },
    steal: { name: 'Steal', coins: 2, blockable: true, blocker: ['Captain', 'Ambassador'], challengeable: true, card: 'Captain' },
    exchange: { name: 'Exchange', blockable: false, challengeable: true, card: 'Ambassador' },
    coup: { name: 'Coup', cost: 7, blockable: false, challengeable: false }
  };

  // Initialize Socket.IO connection
  useEffect(() => {
    // Load Socket.IO client from CDN
    const script = document.createElement('script');
    script.src = 'https://cdn.socket.io/4.5.4/socket.io.min.js';
    script.onload = () => {
      const newSocket = window.io('http://localhost:3001');
      
      newSocket.on('connect', () => {
        console.log('Connected to server');
        setConnected(true);
      });

      newSocket.on('disconnect', () => {
        console.log('Disconnected from server');
        setConnected(false);
      });

      newSocket.on('gameState', (state) => {
        console.log('Game state update:', state);
        setPlayers(state.players);
        setMyPlayerId(state.myPlayerId);
        setCurrentPlayerId(state.currentPlayerId);
        setActionInProgress(state.actionInProgress);
        setGameLog(state.gameLog);
        
        if (state.state === 'lobby') {
          setGameState('lobby');
        } else if (state.state === 'playing') {
          setGameState('playing');
        } else if (state.state === 'ended') {
          setGameState('ended');
        }
      });

      newSocket.on('gameEnded', (data) => {
        setGameState('ended');
      });

      socketRef.current = newSocket;
      setSocket(newSocket);
    };
    
    document.body.appendChild(script);

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  const createRoom = () => {
    if (!socket || !playerName.trim()) {
      setError('Please enter your name');
      return;
    }

    socket.emit('createRoom', { playerName: playerName.trim() }, (response) => {
      if (response.success) {
        setRoomCode(response.roomCode);
        setGameState('lobby');
        setError('');
      } else {
        setError(response.error);
      }
    });
  };

  const joinRoom = () => {
    if (!socket || !playerName.trim() || !joinCode.trim()) {
      setError('Please enter your name and room code');
      return;
    }

    socket.emit('joinRoom', { 
      roomCode: joinCode.trim().toUpperCase(), 
      playerName: playerName.trim() 
    }, (response) => {
      if (response.success) {
        setRoomCode(joinCode.trim().toUpperCase());
        setGameState('lobby');
        setError('');
      } else {
        setError(response.error);
      }
    });
  };

  const startGame = () => {
    if (!socket) return;

    socket.emit('startGame', { roomCode }, (response) => {
      if (!response.success) {
        setError(response.error);
      }
    });
  };

  const performAction = (action, targetId = null) => {
    if (!socket) return;

    socket.emit('performAction', { roomCode, action, targetId }, (response) => {
      if (!response.success) {
        setError(response.error);
      } else {
        setSelectedTarget(null);
      }
    });
  };

  const respondToAction = (responseType, blockCard = null) => {
    if (!socket) return;

    const response = { type: responseType };
    if (blockCard) {
      response.blockCard = blockCard;
    }

    socket.emit('respondToAction', { roomCode, response }, (result) => {
      if (!result.success) {
        setError(result.error);
      }
    });
  };

  const challengeBlock = () => {
    if (!socket) return;

    socket.emit('challengeBlock', { roomCode }, (response) => {
      if (!response.success) {
        setError(response.error);
      }
    });
  };

  const leaveRoom = () => {
    setGameState('menu');
    setRoomCode('');
    setJoinCode('');
    setPlayers([]);
    setActionInProgress(null);
    setGameLog([]);
    setError('');
  };

  // Render functions
  const renderMenu = () => (
    <div className="min-h-screen bg-gradient-to-br from-red-900 via-gray-900 to-black text-white p-8">
      <div className="max-w-md mx-auto">
        <h1 className="text-5xl font-bold text-center mb-8 text-red-500">COUP</h1>
        
        {!connected ? (
          <div className="bg-gray-800 rounded-lg p-8 text-center">
            <div className="animate-pulse mb-4">Connecting to server...</div>
            <div className="text-sm text-gray-400">Make sure the server is running on localhost:3001</div>
          </div>
        ) : (
          <div className="bg-gray-800 rounded-lg p-8 shadow-2xl">
            <input
              type="text"
              placeholder="Enter your name"
              className="w-full p-3 mb-4 bg-gray-700 rounded border border-gray-600 text-white"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && createRoom()}
            />
            
            <button
              onClick={createRoom}
              className="w-full bg-red-600 hover:bg-red-700 p-4 rounded text-xl font-bold mb-4"
              disabled={!playerName.trim()}
            >
              Create New Room
            </button>

            <div className="text-center text-gray-400 my-4">- OR -</div>

            <input
              type="text"
              placeholder="Enter room code"
              className="w-full p-3 mb-4 bg-gray-700 rounded border border-gray-600 text-white uppercase"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              onKeyPress={(e) => e.key === 'Enter' && joinRoom()}
            />

            <button
              onClick={joinRoom}
              className="w-full bg-blue-600 hover:bg-blue-700 p-4 rounded text-xl font-bold"
              disabled={!playerName.trim() || !joinCode.trim()}
            >
              Join Room
            </button>

            {error && (
              <div className="mt-4 p-3 bg-red-900 border border-red-700 rounded text-red-200">
                {error}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  const renderLobby = () => (
    <div className="min-h-screen bg-gradient-to-br from-red-900 via-gray-900 to-black text-white p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold text-red-500">COUP</h1>
          <button
            onClick={leaveRoom}
            className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded"
          >
            Leave Room
          </button>
        </div>

        <div className="bg-gray-800 rounded-lg p-8 shadow-2xl">
          <div className="text-center mb-6">
            <p className="text-gray-400 mb-2">Room Code</p>
            <p className="text-4xl font-bold text-red-500">{roomCode}</p>
            <p className="text-sm text-gray-500 mt-2">Share this code with your friends</p>
          </div>
          
          <div className="mb-6">
            <h3 className="text-xl mb-4 flex items-center gap-2">
              <Users size={20} /> Players ({players.length}/6)
            </h3>
            <div className="space-y-2">
              {players.map(player => (
                <div key={player.id} className="bg-gray-700 p-3 rounded flex items-center justify-between">
                  <span>{player.name}</span>
                  {player.isMe && <span className="text-xs bg-red-600 px-2 py-1 rounded">YOU</span>}
                </div>
              ))}
            </div>
          </div>

          {players.length >= 2 && (
            <button
              onClick={startGame}
              className="w-full bg-red-600 hover:bg-red-700 p-4 rounded text-xl font-bold"
            >
              Start Game
            </button>
          )}

          {players.length < 2 && (
            <div className="text-center text-gray-400">
              Waiting for at least 2 players...
            </div>
          )}

          {error && (
            <div className="mt-4 p-3 bg-red-900 border border-red-700 rounded text-red-200">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderGame = () => {
    const myPlayer = players.find(p => p.id === myPlayerId);
    const isMyTurn = currentPlayerId === myPlayerId;
    const canIRespond = actionInProgress && actionInProgress.playerId !== myPlayerId && myPlayer?.alive;

    return (
      <div className="min-h-screen bg-gradient-to-br from-red-900 via-gray-900 to-black text-white p-4">
        <div className="max-w-7xl mx-auto">
          {/* Header */}
          <div className="flex justify-between items-center mb-6">
            <h1 className="text-3xl font-bold text-red-500">COUP</h1>
            <div className="flex gap-4 items-center">
              <div className="text-gray-400">Room: {roomCode}</div>
              <button
                onClick={leaveRoom}
                className="bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-sm"
              >
                Leave
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Players */}
            <div className="lg:col-span-2">
              <div className="grid grid-cols-2 gap-4 mb-6">
                {players.map((player) => (
                  <div
                    key={player.id}
                    className={`bg-gray-800 rounded-lg p-4 ${
                      player.id === currentPlayerId ? 'ring-2 ring-red-500' : ''
                    } ${!player.alive ? 'opacity-50' : ''} ${
                      selectedTarget === player.id ? 'ring-2 ring-yellow-500' : ''
                    }`}
                  >
                    <div className="flex justify-between items-start mb-3">
                      <div>
                        <h3 className="font-bold text-lg">
                          {player.name}
                          {player.isMe && <span className="text-xs ml-2 text-red-500">(YOU)</span>}
                        </h3>
                        {player.id === currentPlayerId && <span className="text-xs text-red-500">CURRENT TURN</span>}
                      </div>
                      <div className="flex items-center gap-1 text-yellow-500">
                        <Coins size={16} />
                        <span className="font-bold">{player.coins}</span>
                      </div>
                    </div>
                    
                    <div className="flex gap-2">
                      {player.influences?.map((influence, cardIdx) => (
                        <div
                          key={cardIdx}
                          className="relative flex-1 bg-gray-700 rounded p-3 text-center"
                        >
                          {influence.revealed || !player.isMe ? (
                            influence.revealed ? (
                              <>
                                <Eye size={16} className="absolute top-1 right-1 text-red-500" />
                                <div className="text-xs font-bold">{influence.card}</div>
                              </>
                            ) : (
                              <div className="text-2xl">🂠</div>
                            )
                          ) : (
                            <>
                              <EyeOff size={16} className="absolute top-1 right-1 text-gray-500" />
                              <div className="text-xs font-bold">{influence.card}</div>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* Action in Progress - Response Options */}
              {canIRespond && actionInProgress.phase === 'waiting' && (
                <div className="mb-6 bg-yellow-900 border-2 border-yellow-600 rounded-lg p-6">
                  <h3 className="text-xl font-bold mb-4 text-yellow-300">Action in Progress</h3>
                  <p className="mb-4 text-yellow-100">{gameLog[gameLog.length - 1]?.message}</p>
                  <div className="flex gap-3">
                    {actionInProgress.canChallenge && (
                      <button
                        onClick={() => respondToAction('challenge')}
                        className="bg-red-600 hover:bg-red-700 p-3 rounded flex-1 font-bold"
                      >
                        Challenge
                      </button>
                    )}
                    {actionInProgress.canBlock && (
                      <div className="flex-1">
                        <select
                          className="w-full bg-blue-600 hover:bg-blue-700 p-3 rounded font-bold text-white"
                          onChange={(e) => e.target.value && respondToAction('block', e.target.value)}
                          defaultValue=""
                        >
                          <option value="" disabled>Block with...</option>
                          {ACTIONS[actionInProgress.action].blocker && (
                            Array.isArray(ACTIONS[actionInProgress.action].blocker) ? (
                              ACTIONS[actionInProgress.action].blocker.map(card => (
                                <option key={card} value={card}>{card}</option>
                              ))
                            ) : (
                              <option value={ACTIONS[actionInProgress.action].blocker}>
                                {ACTIONS[actionInProgress.action].blocker}
                              </option>
                            )
                          )}
                        </select>
                      </div>
                    )}
                    <button
                      onClick={() => respondToAction('pass')}
                      className="bg-green-600 hover:bg-green-700 p-3 rounded flex-1 font-bold"
                    >
                      Allow
                    </button>
                  </div>
                </div>
              )}

              {/* Block Challenge */}
              {canIRespond && actionInProgress.phase === 'block' && actionInProgress.playerId === myPlayerId && (
                <div className="mb-6 bg-blue-900 border-2 border-blue-600 rounded-lg p-6">
                  <h3 className="text-xl font-bold mb-4 text-blue-300">Block Declared</h3>
                  <p className="mb-4 text-blue-100">
                    {players.find(p => p.id === actionInProgress.blockerId)?.name} blocked with {actionInProgress.blockCard}
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={challengeBlock}
                      className="bg-red-600 hover:bg-red-700 p-3 rounded flex-1 font-bold"
                    >
                      Challenge Block
                    </button>
                    <button
                      onClick={() => respondToAction('pass')}
                      className="bg-green-600 hover:bg-green-700 p-3 rounded flex-1 font-bold"
                    >
                      Accept Block
                    </button>
                  </div>
                </div>
              )}

              {/* My Turn - Actions */}
              {isMyTurn && !actionInProgress && myPlayer?.alive && (
                <div className="bg-gray-800 rounded-lg p-6">
                  <h3 className="text-xl font-bold mb-4 text-red-400">Your Turn - Choose Action</h3>
                  
                  {(selectedTarget || ['income', 'foreignAid', 'tax', 'exchange'].includes(selectedTarget)) ? (
                    <div className="mb-4">
                      <div className="flex justify-between items-center mb-3">
                        <span className="text-gray-300">
                          {selectedTarget && typeof selectedTarget === 'string' && selectedTarget.length === 36 
                            ? `Target: ${players.find(p => p.id === selectedTarget)?.name}`
                            : 'Ready to perform action'}
                        </span>
                        <button
                          onClick={() => setSelectedTarget(null)}
                          className="text-red-400 hover:text-red-300"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={() => performAction('income')}
                      className="bg-green-600 hover:bg-green-700 p-3 rounded"
                    >
                      Income (+1 <Coins size={14} className="inline" />)
                    </button>
                    <button
                      onClick={() => performAction('foreignAid')}
                      className="bg-blue-600 hover:bg-blue-700 p-3 rounded"
                    >
                      Foreign Aid (+2 <Coins size={14} className="inline" />)
                    </button>
                    <button
                      onClick={() => performAction('tax')}
                      className="bg-purple-600 hover:bg-purple-700 p-3 rounded"
                    >
                      Tax - Duke (+3 <Coins size={14} className="inline" />)
                    </button>
                    <button
                      onClick={() => {
                        const targets = players.filter(p => p.id !== myPlayerId && p.alive);
                        if (targets.length === 1) {
                          performAction('steal', targets[0].id);
                        } else {
                          setSelectedTarget('steal');
                        }
                      }}
                      className="bg-orange-600 hover:bg-orange-700 p-3 rounded"
                    >
                      Steal - Captain
                    </button>
                    <button
                      onClick={() => performAction('exchange')}
                      className="bg-teal-600 hover:bg-teal-700 p-3 rounded"
                    >
                      Exchange - Ambassador
                    </button>
                    <button
                      onClick={() => {
                        const targets = players.filter(p => p.id !== myPlayerId && p.alive);
                        if (targets.length === 1) {
                          performAction('assassinate', targets[0].id);
                        } else {
                          setSelectedTarget('assassinate');
                        }
                      }}
                      className="bg-red-600 hover:bg-red-700 p-3 rounded disabled:opacity-50"
                      disabled={myPlayer.coins < 3}
                    >
                      Assassinate (3 <Coins size={14} className="inline" />)
                    </button>
                    <button
                      onClick={() => {
                        const targets = players.filter(p => p.id !== myPlayerId && p.alive);
                        if (targets.length === 1) {
                          performAction('coup', targets[0].id);
                        } else {
                          setSelectedTarget('coup');
                        }
                      }}
                      className="bg-red-900 hover:bg-red-950 p-3 rounded disabled:opacity-50"
                      disabled={myPlayer.coins < 7}
                    >
                      Coup (7 <Coins size={14} className="inline" />)
                    </button>
                  </div>

                  {/* Target Selection */}
                  {selectedTarget && typeof selectedTarget === 'string' && ['steal', 'assassinate', 'coup'].includes(selectedTarget) && (
                    <div className="mt-4 p-4 bg-gray-700 rounded">
                      <h4 className="font-bold mb-3">Select Target:</h4>
                      <div className="grid grid-cols-2 gap-2">
                        {players
                          .filter(p => p.id !== myPlayerId && p.alive)
                          .map(player => (
                            <button
                              key={player.id}
                              onClick={() => performAction(selectedTarget, player.id)}
                              className="bg-gray-600 hover:bg-gray-500 p-3 rounded"
                            >
                              {player.name} ({player.coins} <Coins size={14} className="inline" />)
                            </button>
                          ))}
                      </div>
                    </div>
                  )}

                  {myPlayer.coins >= 10 && (
                    <div className="mt-4 p-3 bg-red-900 border border-red-700 rounded text-center">
                      You must Coup with 10+ coins!
                    </div>
                  )}
                </div>
              )}

              {error && (
                <div className="mt-4 p-3 bg-red-900 border border-red-700 rounded text-red-200">
                  {error}
                </div>
              )}
            </div>

            {/* Game Log */}
            <div className="bg-gray-800 rounded-lg p-4 h-[600px] overflow-y-auto">
              <h3 className="font-bold mb-3 sticky top-0 bg-gray-800 pb-2">Game Log</h3>
              <div className="space-y-2">
                {gameLog.map((log, idx) => (
                  <div key={idx} className="text-sm text-gray-300 border-l-2 border-gray-700 pl-2">
                    {log.message}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderEndGame = () => {
    const winner = players.find(p => p.alive);
    
    return (
      <div className="min-h-screen bg-gradient-to-br from-red-900 via-gray-900 to-black text-white flex items-center justify-center">
        <div className="bg-gray-800 rounded-lg p-12 text-center max-w-md">
          <h1 className="text-4xl font-bold mb-4">Game Over!</h1>
          <p className="text-2xl mb-8 text-red-400">{winner?.name} wins!</p>
          <button
            onClick={leaveRoom}
            className="bg-red-600 hover:bg-red-700 p-4 rounded text-xl font-bold w-full"
          >
            Back to Menu
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      {gameState === 'menu' && renderMenu()}
      {gameState === 'lobby' && renderLobby()}
      {gameState === 'playing' && renderGame()}
      {gameState === 'ended' && renderEndGame()}
    </>
  );
};

export default CoupGame;