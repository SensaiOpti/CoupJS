const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const jwt = require('jsonwebtoken');
const auth = require('./auth');
const db = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'coup-secret-key-change-in-production';

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 10000, // How long to wait for pong before disconnect (10s)
  pingInterval: 5000, // How often to send ping (5s)
  connectTimeout: 10000 // Connection timeout
});

app.use(express.json());

// Authentication routes
app.post('/api/register', (req, res) => {
  const { username, password, email } = req.body;
  const result = auth.register(username, password, email);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const result = auth.login(username, password);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(401).json(result);
  }
});

app.post('/api/verify', (req, res) => {
  const { token } = req.body;
  const result = auth.verifyToken(token);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(401).json(result);
  }
});

// Guest login (for backward compatibility)
app.post('/api/guest', (req, res) => {
  const guestId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  res.json({
    success: true,
    isGuest: true,
    guestId: guestId,
    username: `Guest${Math.floor(Math.random() * 9999)}`
  });
});

// Update user deck preference
app.post('/api/user/deck-preference', (req, res) => {
  const { token, deckPreference } = req.body;
  
  // Verify token
  const verification = auth.verifyToken(token);
  if (!verification.success) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Validate deck preference
  const validDecks = ['default', 'anime', 'pixel', 'minimalist'];
  if (!validDecks.includes(deckPreference)) {
    return res.status(400).json({ error: 'Invalid deck preference' });
  }
  
  try {
    // Update deck preference
    const updateDeck = db.prepare(`
      UPDATE users
      SET deck_preference = ?
      WHERE id = ?
    `);
    updateDeck.run(deckPreference, verification.user.id);
    db.saveDatabase();
    
    res.json({
      success: true,
      deck_preference: deckPreference
    });
  } catch (error) {
    console.error('Error updating deck preference:', error);
    res.status(500).json({ error: 'Failed to update deck preference' });
  }
});

// GET /api/user/settings - Get current user settings
app.get('/api/user/settings', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  const verification = auth.verifyToken(token);
  if (!verification.success) return res.status(401).json({ error: 'Unauthorized' });
  
  try {
    const user = db.prepare('SELECT deck_preference, privacy_settings, bio FROM users WHERE id = ?').get(verification.user.id);
    const privacy = JSON.parse(user.privacy_settings || '{}');
    res.json({
      deckPreference: user.deck_preference || 'default',
      bio: user.bio || '',
      privacy: {
        showIndividualStats: privacy.showIndividualStats === true,
        showWinRate: privacy.showWinRate === true,
        showAchievements: privacy.showAchievements === true,
        showMatchHistory: privacy.showMatchHistory === true
      }
    });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// POST /api/user/settings - Save user settings
app.post('/api/user/settings', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1] || req.body.token;
  const verification = auth.verifyToken(token);
  if (!verification.success) return res.status(401).json({ error: 'Unauthorized' });
  
  try {
    const { privacy, deckPreference, bio } = req.body;
    
    // Build update
    const user = db.prepare('SELECT deck_preference, privacy_settings, bio FROM users WHERE id = ?').get(verification.user.id);
    const currentPrivacy = JSON.parse(user.privacy_settings || '{}');
    const newPrivacy = { ...currentPrivacy, ...privacy };
    
    const validDecks = ['default', 'anime', 'pixel', 'minimalist'];
    const newDeck = validDecks.includes(deckPreference) ? deckPreference : user.deck_preference;
    
    // Limit bio to 250 characters
    const newBio = typeof bio === 'string' ? bio.substring(0, 250) : user.bio || '';
    
    db.prepare('UPDATE users SET privacy_settings = ?, deck_preference = ?, bio = ? WHERE id = ?')
      .run(JSON.stringify(newPrivacy), newDeck, newBio, verification.user.id);
    db.saveDatabase();
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving settings:', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});


// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Root route - redirect based on auth status
app.get('/', (req, res) => {
  res.redirect('/login.html');
});

// Serve the game interface
app.get('/game.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve the rules page
app.get('/rules.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'rules.html'));
});

// Serve the settings page
app.get('/settings.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// Serve the lobby page
app.get('/lobby.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lobby.html'));
});

// Serve the create game page
app.get('/create-game.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'create-game.html'));
});

// Game state storage
const rooms = new Map();
const disconnectionTimers = new Map(); // Map of playerId -> timeout
const DISCONNECTION_GRACE_PERIOD = 30000; // 30 seconds

// Card definitions
const CARDS = ['Duke', 'Assassin', 'Captain', 'Ambassador', 'Contessa'];
const INQUISITOR_CARDS = ['Duke', 'Assassin', 'Captain', 'Inquisitor', 'Contessa'];

const ACTIONS = {
  income: { name: 'Income', coins: 1, blockable: false, challengeable: false },
  foreignAid: { name: 'Foreign Aid', coins: 2, blockable: true, blocker: ['Duke'], challengeable: false },
  tax: { name: 'Tax', coins: 3, blockable: false, challengeable: true, card: 'Duke' },
  assassinate: { name: 'Assassinate', cost: 3, blockable: true, blocker: ['Contessa'], challengeable: true, card: 'Assassin' },
  steal: { name: 'Steal', coins: 2, blockable: true, blocker: ['Captain', 'Ambassador', 'Inquisitor'], challengeable: true, card: 'Captain' },
  exchange: { name: 'Exchange', blockable: false, challengeable: true, card: 'Ambassador' },
  examine: { name: 'Examine', blockable: false, challengeable: true, card: 'Inquisitor' },
  coup: { name: 'Coup', cost: 7, blockable: false, challengeable: false }
};

// Utility functions
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function shuffleDeck(useInquisitor = false) {
  const deck = [];
  const cardSet = useInquisitor ? INQUISITOR_CARDS : CARDS;
  cardSet.forEach(card => {
    for (let i = 0; i < 3; i++) {
      deck.push(card);
    }
  });
  return deck.sort(() => Math.random() - 0.5);
}

function createRoom(roomCode, options = {}) {
  return {
    code: roomCode,
    name: options.name || null,
    players: [],
    spectators: [],
    state: 'lobby',
    deck: [],
    currentPlayerIndex: 0,
    actionInProgress: null,
    gameLog: [],
    pendingResponses: new Set(),
    useInquisitor: options.useInquisitor || false,
    allowSpectators: options.allowSpectators !== false, // Default to true
    chatMode: options.chatMode || 'separate', // Default to separate
    password: options.password || null, // Optional password protection
    ranked: options.ranked !== false, // Default to ranked (true)
    anonymousMode: options.anonymousMode || false, // Default to false
    gameStartTime: null, // Track when game starts
    gameEndTime: null, // Track when game ends
    eliminationOrder: [] // Track order of elimination: [{playerId, playerName, coins, placement}]
  };
}

function addLogToRoom(room, message, type = 'info', character = null) {
  room.gameLog.push({
    time: Date.now(),
    message,
    type, // 'info', 'action', 'challenge', 'block', 'success', 'fail'
    character // 'Duke', 'Assassin', 'Captain', 'Ambassador', 'Inquisitor', 'Contessa', or action names
  });
}

function getPlayerBySocketId(room, socketId) {
  return room.players.find(p => p.socketId === socketId);
}

function getSpectatorBySocketId(room, socketId) {
  return room.spectators.find(s => s.socketId === socketId);
}

function getPlayerById(room, playerId) {
  return room.players.find(p => p.id === playerId);
}

function generateAnonymousName(usedNames) {
  try {
    const titles = ['Ambassador', 'Assassin', 'Captain', 'Contessa', 'Duke', 'Inquisitor'];
    const fs = require('fs');
    const path = require('path');
    
    // Read names from the public directory
    const namesPath = path.join(__dirname, 'public', 'randomnames.txt');
    const names = fs.readFileSync(namesPath, 'utf-8')
      .split('\n')
      .map(n => n.trim())
      .filter(n => n.length > 0);
    
    let attempts = 0;
    let anonymousName;
    
    do {
      const title = titles[Math.floor(Math.random() * titles.length)];
      const name = names[Math.floor(Math.random() * names.length)];
      anonymousName = `${title}${name}`;
      attempts++;
    } while (usedNames.has(anonymousName) && attempts < 100);
    
    usedNames.add(anonymousName);
    return anonymousName;
  } catch (error) {
    console.error('Error generating anonymous name:', error);
    return `Player${Math.floor(Math.random() * 1000)}`;
  }
}

function emitToRoom(roomCode, event, customData = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  // If custom data is provided, send it directly
  if (customData !== null) {
    room.players.forEach(player => {
      if (!player.hasLeft) {
        io.to(player.socketId).emit(event, customData);
      }
    });
    room.spectators.forEach(spectator => {
      if (!spectator.hasLeft) {
        io.to(spectator.socketId).emit(event, customData);
      }
    });
    return;
  }
  
  // Otherwise, send personalized game state to each player who hasn't left
  room.players.forEach(player => {
    if (!player.hasLeft) {
      io.to(player.socketId).emit(event, getPublicGameState(room, player.socketId, false));
    }
  });

  // Send spectator view to all spectators
  room.spectators.forEach(spectator => {
    if (!spectator.hasLeft) {
      io.to(spectator.socketId).emit(event, getPublicGameState(room, spectator.socketId, true));
    }
  });
}

// Helper function to clear action and associated timeout
function clearActionAndTimeout(room) {
  if (room.responseTimeout) {
    clearTimeout(room.responseTimeout);
    room.responseTimeout = null;
  }
  if (room.actionInProgress && room.actionInProgress.responseTimeout) {
    clearTimeout(room.actionInProgress.responseTimeout);
    room.actionInProgress.responseTimeout = null;
  }
  room.actionInProgress = null;
}

function getPublicGameState(room, socketId, isSpectator = false) {
  const player = getPlayerBySocketId(room, socketId);
  const spectator = getSpectatorBySocketId(room, socketId);
  
  // Clean up actionInProgress for sending to client (remove timeout reference)
  let cleanActionInProgress = null;
  if (room.actionInProgress) {
    const { responseTimeout, ...cleanAction } = room.actionInProgress;
    cleanActionInProgress = cleanAction;
  }
  
  return {
    roomCode: room.code,
    state: room.state,
    useInquisitor: room.useInquisitor,
    allowSpectators: room.allowSpectators,
    chatMode: room.chatMode,
    hasPassword: !!room.password, // Only expose if password exists, not the actual password
    ranked: room.ranked,
    anonymousMode: room.anonymousMode,
    deckSize: room.deck.length,
    isSpectator: isSpectator,
    players: room.players.map(p => {
      const displayName = room.anonymousMode && room.state === 'playing' && p.anonymousName ? p.anonymousName : p.name;
      return {
        id: p.id,
        name: displayName,
        username: p.username || null,
        isGuest: p.isGuest === true,
        userId: p.userId || null,
        stats: p.stats || null,
        coins: p.coins,
        influenceCount: p.influences.length,
        disconnected: p.disconnected || false,
        hasLeft: p.hasLeft || false,
        // Spectators can see all cards, players can only see their own cards
        influences: (p.socketId === socketId && !isSpectator) || isSpectator ? p.influences : p.influences.map(inf => inf.revealed ? inf : { revealed: false }),
        alive: p.alive,
        mustRevealInfluence: p.mustRevealInfluence || false,
        influencesToLose: p.influencesToLose || 0,
        mustChooseExchange: p.mustChooseExchange || false,
        mustChooseExamine: p.mustChooseExamine || false,
        mustShowCardToExaminer: p.mustShowCardToExaminer || false,
        examineTargetId: p.examineTargetId || null,
        examinedCard: (p.socketId === socketId && !isSpectator) ? (p.examinedCard || null) : null,
        exchangeCards: (p.socketId === socketId && !isSpectator) ? (p.exchangeCards || null) : null,
        isMe: p.socketId === socketId && !isSpectator
      };
    }),
    spectators: room.spectators.map(s => ({
      id: s.id,
      name: s.name,
      isMe: s.socketId === socketId && isSpectator
    })),
    currentPlayerIndex: room.currentPlayerIndex,
    currentPlayerId: room.players[room.currentPlayerIndex]?.id,
    actionInProgress: cleanActionInProgress,
    gameLog: room.gameLog.filter(log => {
      // Always show non-chat messages
      if (log.type !== 'chat') return true;
      
      // If chat is disabled, don't show chat messages
      if (room.chatMode === 'none') return false;
      
      // If unified chat, show all messages
      if (room.chatMode === 'unified') return true;
      
      // Separate chat mode: filter by sender/receiver type
      if (room.chatMode === 'separate') {
        // Spectators see all chat (player + spectator)
        if (isSpectator) return true;
        // Players only see player chat
        return log.isSpectator === false;
      }
      
      return true;
    }),
    myPlayerId: player?.id || null
  };
}

function startGame(room) {
  if (room.players.length < 2 || room.players.length > 6) {
    return { success: false, error: 'Need 2-6 players' };
  }

  // Randomize player order
  room.players.sort(() => Math.random() - 0.5);

  // Generate anonymous names if in anonymous mode
  if (room.anonymousMode) {
    const usedNames = new Set();
    room.players.forEach(player => {
      player.anonymousName = generateAnonymousName(usedNames);
    });
  }

  room.deck = shuffleDeck(room.useInquisitor);
  room.state = 'playing';
  room.currentPlayerIndex = 0;
  room.gameStartTime = new Date(); // Record game start time

  // Deal 2 cards to each player
  room.players.forEach((player, idx) => {
    player.influences = [
      { card: room.deck.pop(), revealed: false },
      { card: room.deck.pop(), revealed: false }
    ];
    player.coins = 2;
    player.alive = true;
    
    // Initialize game stats tracking
    player.gameStats = {
      // Core stats
      coinsEarned: 2, // Start with the 2 coins everyone gets
      coinsSpent: 0,
      coinsLost: 0,
      coinsStolen: 0,
      influencesLost: 0,
      actionsPerformed: 0,
      incomeTaken: 0,
      coupsEnacted: 0,
      playersEliminated: 0,
      
      // Challenge/Bluff stats
      successfulChallenges: 0,
      failedChallenges: 0,
      claimsDefended: 0,
      bluffsCaught: 0,
      bluffsSucceeded: 0,
      
      // Action-specific stats
      taxSucceeded: 0,
      taxFailed: 0,
      foreignaidAccepted: 0,
      foreignaidDenied: 0,
      foreignaidblockSucceeded: 0,
      foreignaidblockFailed: 0,
      stealsBlocked: 0,
      
      // Assassination stats
      assassinationsSucceeded: 0,
      assassinationsFailed: 0,
      contessaSucceeded: 0,
      contessaFailed: 0,
      
      // Exchange/Examine stats
      influenceExchanged: 0,
      influenceExamined: 0,
      influenceForced: 0
    };
  });

  const cardType = room.useInquisitor ? 'Inquisitor' : 'Ambassador';
  addLogToRoom(room, `ðŸŽ® Game started! Each player has 2 influence cards and 2 coins.`, 'info');
  addLogToRoom(room, `ðŸŽ² ${room.players[0].name} will go first!`, 'info');
  addLogToRoom(room, `--- ${room.players[0].name}'s turn ---`, 'info');
  return { success: true };
}

function performAction(room, socketId, action, targetId) {
  const player = getPlayerBySocketId(room, socketId);
  if (!player) return { success: false, error: 'Player not found' };

  if (room.players[room.currentPlayerIndex].socketId !== socketId) {
    return { success: false, error: 'Not your turn' };
  }

  if (room.actionInProgress) {
    return { success: false, error: 'Action already in progress' };
  }

  // Check if anyone needs to reveal an influence
  const someoneRevealing = room.players.some(p => p.mustRevealInfluence);
  if (someoneRevealing) {
    return { success: false, error: 'Waiting for player to reveal influence' };
  }

  // Check if anyone is in the middle of an exchange
  const someoneExchanging = room.players.some(p => p.mustChooseExchange);
  if (someoneExchanging) {
    return { success: false, error: 'Waiting for exchange to complete' };
  }

  // Check if anyone is showing a card to an examiner
  const someoneShowingCard = room.players.some(p => p.mustShowCardToExaminer);
  if (someoneShowingCard) {
    return { success: false, error: 'Waiting for card to be shown' };
  }

  // Check if anyone is examining a card
  const someoneExamining = room.players.some(p => p.mustChooseExamine);
  if (someoneExamining) {
    return { success: false, error: 'Waiting for examination to complete' };
  }

  const actionData = ACTIONS[action];
  if (!actionData) {
    return { success: false, error: 'Invalid action' };
  }

  if (actionData.cost && player.coins < actionData.cost) {
    return { success: false, error: 'Not enough coins' };
  }

  // Mandatory coup at 10+ coins
  if (player.coins >= 10 && action !== 'coup') {
    return { success: false, error: 'Must coup with 10+ coins' };
  }

  const targetPlayer = targetId ? getPlayerById(room, targetId) : null;
  if ((action === 'steal' || action === 'assassinate' || action === 'coup' || action === 'examine') && !targetPlayer) {
    return { success: false, error: 'Target required' };
  }

  // Filter blockers based on game mode (remove Ambassador if using Inquisitor)
  let blockers = actionData.blocker;
  if (actionData.blockable && room.useInquisitor && Array.isArray(blockers)) {
    blockers = blockers.filter(card => card !== 'Ambassador');
  }

  // Clear any existing timer from previous action
  if (room.responseTimeout) {
    clearTimeout(room.responseTimeout);
    room.responseTimeout = null;
  }
  if (room.actionInProgress && room.actionInProgress.responseTimeout) {
    clearTimeout(room.actionInProgress.responseTimeout);
    room.actionInProgress.responseTimeout = null;
  }

  room.actionInProgress = {
    action,
    playerId: player.id,
    playerName: player.name,
    targetId,
    targetName: targetPlayer?.name,
    canChallenge: actionData.challengeable,
    canBlock: actionData.blockable,
    blocker: blockers,
    responses: {},
    phase: 'waiting',
    totalResponders: 0,
    respondedCount: 0
  };

  // Generate appropriate log message
  if (action === 'foreignAid') {
    addLogToRoom(room, `${player.name} takes Foreign Aid`, 'action', 'ForeignAid');
  } else if (action === 'tax') {
    addLogToRoom(room, `${player.name} claims to be the Duke and uses Tax (+3 coins)`, 'action', 'Duke');
  } else if (action === 'assassinate') {
    addLogToRoom(room, `${player.name} claims to be the Assassin and attempts to assassinate ${targetPlayer.name}`, 'action', 'Assassin');
  } else if (action === 'steal') {
    addLogToRoom(room, `${player.name} claims to be the Captain and attempts to steal from ${targetPlayer.name}`, 'action', 'Captain');
  } else if (action === 'exchange') {
    const card = room.useInquisitor ? 'Inquisitor' : 'Ambassador';
    addLogToRoom(room, `${player.name} claims to be the ${card} and uses Exchange`, 'action', card);
  } else if (action === 'examine') {
    addLogToRoom(room, `${player.name} claims to be the Inquisitor and examines ${targetPlayer.name}`, 'action', 'Inquisitor');
  }

  // If action can be challenged or blocked, wait for responses
  if (actionData.challengeable || actionData.blockable) {
    // Determine who can respond
    let eligibleResponders;
    
    if (actionData.blockable && targetId) {
      // For targeted blockable actions (steal, assassinate), only the target can block
      // But anyone can still challenge
      eligibleResponders = room.players.filter(p => p.alive && p.id !== player.id && !p.disconnected);
      
      // Mark who can actually block vs who can only challenge
      room.actionInProgress.blockableByTarget = true;
      room.actionInProgress.targetCanBlock = targetId;
    } else {
      // For non-targeted actions (foreign aid, tax, etc), anyone can respond
      eligibleResponders = room.players.filter(p => p.alive && p.id !== player.id && !p.disconnected);
    }
    
    room.pendingResponses = new Set(eligibleResponders.map(p => p.id));
    room.actionInProgress.totalResponders = eligibleResponders.length;
    room.actionInProgress.respondedCount = 0;
    
    // If no one can respond (e.g., all other players are disconnected), resolve immediately
    if (eligibleResponders.length === 0) {
      resolveAction(room);
      return { success: true };
    }
    
    // Check if target is disconnected (for blockable actions)
    const targetIsDisconnected = targetPlayer && targetPlayer.disconnected;
    
    if (targetIsDisconnected) {
      room.actionInProgress.pausedForDisconnection = true;
      addLogToRoom(room, `âš ï¸ Waiting for ${targetPlayer.name} to reconnect to respond to this action...`, 'info');
    } else {
      // Set timeout for responses (12 seconds)
      const timeoutId = setTimeout(() => {
        if (room.actionInProgress && room.actionInProgress.phase === 'waiting') {
          // Log that no one responded
          if (room.actionInProgress.action === 'foreignAid') {
            addLogToRoom(room, `No one blocked Foreign Aid`, 'info');
          }
          resolveAction(room);
          emitToRoom(room.code, 'gameState');
        }
      }, 12000); // 12 seconds
      
      // Store at both levels so we always have a reference
      room.actionInProgress.responseTimeout = timeoutId;
      room.responseTimeout = timeoutId;
    }
  } else {
    // No responses needed, resolve immediately
    resolveAction(room);
  }

  return { success: true };
}

function respondToAction(room, socketId, response) {
  const player = getPlayerBySocketId(room, socketId);
  if (!player || !room.actionInProgress) {
    return { success: false, error: 'Invalid response' };
  }

  // Verify this player is in the pending responses set
  if (!room.pendingResponses.has(player.id)) {
    return { success: false, error: 'Not eligible to respond' };
  }

  // Check if player has already responded
  if (room.actionInProgress.responses[player.id]) {
    return { success: false, error: 'Already responded' };
  }

  // During the initial action phase, can't respond to your own action
  // During the block phase, anyone except the blocker can respond
  if (room.actionInProgress.phase === 'waiting' && room.actionInProgress.playerId === player.id) {
    return { success: false, error: 'Cannot respond to your own action' };
  }

  if (room.actionInProgress.phase === 'block' && room.actionInProgress.blockerId === player.id) {
    return { success: false, error: 'Cannot respond to your own block' };
  }

  // Check if trying to block a targeted action when not the target
  if (response.type === 'block' && room.actionInProgress.blockableByTarget) {
    if (player.id !== room.actionInProgress.targetCanBlock) {
      return { success: false, error: 'Only the target can block this action' };
    }
  }

  room.actionInProgress.responses[player.id] = response;
  room.pendingResponses.delete(player.id);
  
  // Update responded count
  if (room.actionInProgress) {
    room.actionInProgress.respondedCount = room.actionInProgress.totalResponders - room.pendingResponses.size;
  }

  if (response.type === 'challenge') {
    handleChallenge(room, player.id);
  } else if (response.type === 'block') {
    handleBlock(room, player.id, response.blockCard);
  } else if (response.type === 'pass') {
    // Check if all CONNECTED players have responded
    if (room.actionInProgress.phase === 'block') {
      // In block phase, if everyone who can respond has passed
      if (room.pendingResponses.size === 0) {
        // Check if there are disconnected players who could have challenged
        const hasDisconnectedChallengers = room.players.some(p => 
          p.alive && 
          p.id !== room.actionInProgress.blockerId && 
          p.disconnected
        );
        
        if (!hasDisconnectedChallengers) {
          // No disconnected players waiting - block succeeds
          const blocker = getPlayerById(room, room.actionInProgress.blockerId);
          const originalActor = getPlayerById(room, room.actionInProgress.playerId);
          
          if (blocker && blocker.gameStats) {
            // Check if they actually had the blocking card
            const hasCard = blocker.influences.some(inf => !inf.revealed && inf.card === room.actionInProgress.blockCard);
            if (hasCard) {
              // Had the card - successful claim defense
              blocker.gameStats.claimsDefended += 1;
            } else {
              // Didn't have the card - successful bluff!
              blocker.gameStats.bluffsSucceeded += 1;
            }
            
            // Track block-specific stats
            if (room.actionInProgress.action === 'steal') {
              blocker.gameStats.stealsBlocked += 1;
            } else if (room.actionInProgress.action === 'assassinate') {
              blocker.gameStats.contessaSucceeded += 1;
            } else if (room.actionInProgress.action === 'foreignAid') {
              blocker.gameStats.foreignaidblockSucceeded += 1;
            }
          }
          
          // Track stats for the original actor whose action was blocked
          if (originalActor && originalActor.gameStats) {
            if (room.actionInProgress.action === 'foreignAid') {
              originalActor.gameStats.foreignaidDenied += 1;
            } else if (room.actionInProgress.action === 'assassinate') {
              originalActor.gameStats.assassinationsFailed += 1;
            }
          }
          
          if (room.actionInProgress.action === 'foreignAid') {
            addLogToRoom(room, `No one challenges the block. Foreign Aid is blocked!`, 'success', room.actionInProgress.blockCard);
          } else {
            addLogToRoom(room, `No one challenges the block. The action is blocked!`, 'success', room.actionInProgress.blockCard);
          }
          clearActionAndTimeout(room);
          nextTurn(room);
        } else {
          // Still waiting for disconnected players - pause
          if (!room.actionInProgress.pausedForDisconnection) {
            room.actionInProgress.pausedForDisconnection = true;
            const disconnectedNames = room.players
              .filter(p => p.alive && p.id !== room.actionInProgress.blockerId && p.disconnected)
              .map(p => p.name)
              .join(', ');
            addLogToRoom(room, `âš ï¸ Waiting for ${disconnectedNames} to reconnect to respond to block...`, 'info');
            
            // Clear any existing timeout
            if (room.actionInProgress.responseTimeout) {
              clearTimeout(room.actionInProgress.responseTimeout);
              room.actionInProgress.responseTimeout = null;
            }
          }
        }
      }
    } else if (room.pendingResponses.size === 0) {
      // All connected players passed on challenging/blocking in action phase
      // Check if target is disconnected (for blockable actions)
      const targetPlayer = room.actionInProgress.targetId ? 
        getPlayerById(room, room.actionInProgress.targetId) : null;
      const targetIsDisconnected = targetPlayer && targetPlayer.disconnected;
      
      if (!targetIsDisconnected) {
        // No disconnected target - resolve action
        if (room.actionInProgress.action === 'foreignAid') {
          addLogToRoom(room, `No one blocked Foreign Aid`, 'info');
        }
        resolveAction(room);
      } else {
        // Target is disconnected - pause and wait
        if (!room.actionInProgress.pausedForDisconnection) {
          room.actionInProgress.pausedForDisconnection = true;
          addLogToRoom(room, `âš ï¸ Waiting for ${targetPlayer.name} to reconnect to respond to this action...`, 'info');
          
          // Clear any existing timeout
          if (room.actionInProgress.responseTimeout) {
            clearTimeout(room.actionInProgress.responseTimeout);
            room.actionInProgress.responseTimeout = null;
          }
        }
      }
    }
  }

  return { success: true };
}

function handleChallenge(room, challengerId) {
  const action = room.actionInProgress;
  const challenger = getPlayerById(room, challengerId);
  const actor = getPlayerById(room, action.playerId);
  const actionData = ACTIONS[action.action];

  // Clear any existing timer since challenge resolves the action
  if (action.responseTimeout) {
    clearTimeout(action.responseTimeout);
    action.responseTimeout = null;
  }

  addLogToRoom(room, `${challenger.name} challenges ${actor.name}!`, 'challenge');

  // Check if actor has the claimed card
  const hasCard = actor.influences.some(inf => !inf.revealed && inf.card === actionData.card);

  if (hasCard) {
    // Challenge failed - challenger loses influence
    addLogToRoom(room, `${actor.name} reveals the ${actionData.card}! The challenge fails.`, 'fail', actionData.card);
    addLogToRoom(room, `${challenger.name} loses an influence`, 'info');
    
    // Track stats
    if (challenger.gameStats) challenger.gameStats.failedChallenges += 1;
    if (actor.gameStats) actor.gameStats.claimsDefended += 1; // Successfully defended claim
    
    loseInfluence(room, challengerId, 1, action.playerId);
    
    // Actor returns card and draws new one
    const cardIndex = actor.influences.findIndex(inf => !inf.revealed && inf.card === actionData.card);
    if (cardIndex !== -1 && room.deck.length > 0) {
      actor.influences[cardIndex].card = room.deck.pop();
      room.deck.unshift(actionData.card);
      room.deck.sort(() => Math.random() - 0.5);
      addLogToRoom(room, `${actor.name} returns the card and draws a new one`, 'info');
    }
    
    // Log the successful action
    if (action.action === 'tax') {
      addLogToRoom(room, `${actor.name} successfully uses Tax and takes 3 coins`, 'success', 'Duke');
    } else if (action.action === 'steal') {
      addLogToRoom(room, `${actor.name} successfully steals from ${action.targetName}`, 'success', 'Captain');
    } else if (action.action === 'assassinate') {
      addLogToRoom(room, `${actor.name} successfully assassinates ${action.targetName}`, 'success', 'Assassin');
    } else if (action.action === 'exchange') {
      const card = room.useInquisitor ? 'Inquisitor' : 'Ambassador';
      addLogToRoom(room, `${actor.name} successfully exchanges cards`, 'success', card);
    } else if (action.action === 'examine') {
      addLogToRoom(room, `${actor.name} successfully examines ${action.targetName}`, 'success', 'Inquisitor');
    }
    
    resolveAction(room);
  } else {
    // Challenge succeeded - actor loses influence (was bluffing)
    addLogToRoom(room, `${actor.name} doesn't have the ${actionData.card}! The challenge succeeds.`, 'success', actionData.card);
    addLogToRoom(room, `${actor.name} loses an influence and the action fails`, 'info');
    
    // Track stats
    if (challenger.gameStats) challenger.gameStats.successfulChallenges += 1;
    if (actor.gameStats) {
      actor.gameStats.bluffsCaught += 1; // Caught bluffing
      
      // Track action-specific failures
      if (action.action === 'tax') {
        actor.gameStats.taxFailed += 1;
      } else if (action.action === 'assassinate') {
        actor.gameStats.assassinationsFailed += 1;
      }
    }
    
    loseInfluence(room, action.playerId, 1, challengerId);
    clearActionAndTimeout(room);
    nextTurn(room);
  }
}

function handleBlock(room, blockerId, blockCard) {
  const action = room.actionInProgress;
  const blocker = getPlayerById(room, blockerId);
  
  if (action.action === 'foreignAid') {
    addLogToRoom(room, `${blocker.name} claims to be the ${blockCard} and blocks Foreign Aid`, 'block', blockCard);
  } else {
    addLogToRoom(room, `${blocker.name} claims to be the ${blockCard} and blocks!`, 'block', blockCard);
  }
  
  // Now the block can be challenged by ANY player
  room.actionInProgress.phase = 'block';
  room.actionInProgress.blockerId = blockerId;
  room.actionInProgress.blockCard = blockCard;
  
  // All players except the blocker can challenge
  const eligibleChallengersList = room.players.filter(p => p.alive && p.id !== blockerId && !p.disconnected);
  room.pendingResponses = new Set(eligibleChallengersList.map(p => p.id));
  room.actionInProgress.totalResponders = eligibleChallengersList.length;
  room.actionInProgress.respondedCount = 0;
  
  // If no one can challenge (e.g., all other players are disconnected), block succeeds immediately
  if (eligibleChallengersList.length === 0) {
    const blocker = getPlayerById(room, blockerId);
    if (blocker && blocker.gameStats) {
      const hasCard = blocker.influences.some(inf => !inf.revealed && inf.card === blockCard);
      if (hasCard) {
        blocker.gameStats.claimsDefended += 1;
      } else {
        blocker.gameStats.bluffsSucceeded += 1;
      }
      if (action.action === 'steal') {
        blocker.gameStats.stealsBlocked += 1;
      } else if (action.action === 'assassinate') {
        blocker.gameStats.contessaSucceeded += 1;
      } else if (action.action === 'foreignAid') {
        blocker.gameStats.foreignaidblockSucceeded += 1;
      }
    }
    
    const originalActor = getPlayerById(room, action.playerId);
    if (originalActor && originalActor.gameStats) {
      if (action.action === 'foreignAid') {
        originalActor.gameStats.foreignaidDenied += 1;
      } else if (action.action === 'assassinate') {
        originalActor.gameStats.assassinationsFailed += 1;
      }
    }
    
    if (action.action === 'foreignAid') {
      addLogToRoom(room, `The block succeeds. Foreign Aid is blocked!`, 'success', blockCard);
    } else {
      addLogToRoom(room, `The block succeeds!`, 'success', blockCard);
    }
    clearActionAndTimeout(room);
    nextTurn(room);
    return;
  }
  
  // Check if there are any disconnected players who could challenge
  const hasDisconnectedChallengers = room.players.some(p => p.alive && p.id !== blockerId && p.disconnected);
  
  if (hasDisconnectedChallengers) {
    room.actionInProgress.pausedForDisconnection = true;
    const disconnectedNames = room.players
      .filter(p => p.alive && p.id !== blockerId && p.disconnected)
      .map(p => p.name)
      .join(', ');
    addLogToRoom(room, `âš ï¸ Waiting for ${disconnectedNames} to reconnect to respond to block...`, 'info');
  } else {
    // Clear any previous timeout before setting new one
    if (room.responseTimeout) {
      clearTimeout(room.responseTimeout);
      room.responseTimeout = null;
    }
    
    const timeoutId = setTimeout(() => {
      if (room.actionInProgress && room.actionInProgress.phase === 'block') {
        // Block succeeded without being challenged
        const blocker = getPlayerById(room, room.actionInProgress.blockerId);
        const originalActor = getPlayerById(room, room.actionInProgress.playerId);
        
        if (blocker && blocker.gameStats) {
          // Check if they actually had the blocking card
          const hasCard = blocker.influences.some(inf => !inf.revealed && inf.card === room.actionInProgress.blockCard);
          if (hasCard) {
            // Had the card - successful claim defense
            blocker.gameStats.claimsDefended += 1;
          } else {
            // Didn't have the card - successful bluff!
            blocker.gameStats.bluffsSucceeded += 1;
          }
          
          // Track block-specific stats
          if (action.action === 'steal') {
            blocker.gameStats.stealsBlocked += 1;
          } else if (action.action === 'assassinate') {
            blocker.gameStats.contessaSucceeded += 1;
          } else if (action.action === 'foreignAid') {
            blocker.gameStats.foreignaidblockSucceeded += 1;
          }
        }
        
        // Track stats for the original actor whose action was blocked
        if (originalActor && originalActor.gameStats) {
          if (action.action === 'foreignAid') {
            originalActor.gameStats.foreignaidDenied += 1;
          } else if (action.action === 'assassinate') {
            originalActor.gameStats.assassinationsFailed += 1;
          }
        }
        
        if (action.action === 'foreignAid') {
          addLogToRoom(room, `No one challenges the block. Foreign Aid is blocked!`, 'success', blockCard);
        } else {
          addLogToRoom(room, `No one challenges the block. The action is blocked!`, 'success', blockCard);
        }
        clearActionAndTimeout(room);
        nextTurn(room);
        emitToRoom(room.code, 'gameState');
      }
    }, 12000); // 12 seconds
    
    // Store at both levels so we always have a reference
    room.actionInProgress.responseTimeout = timeoutId;
    room.responseTimeout = timeoutId;
  }
}

function challengeBlock(room, socketId) {
  const action = room.actionInProgress;
  const challenger = getPlayerBySocketId(room, socketId);
  const blocker = getPlayerById(room, action.blockerId);
  
  if (!blocker || !action.blockCard) {
    return { success: false, error: 'Invalid block challenge' };
  }

  if (challenger.id === action.blockerId) {
    return { success: false, error: 'Cannot challenge your own block' };
  }
  
  // Clear any existing timer since challenge resolves the block
  if (action.responseTimeout) {
    clearTimeout(action.responseTimeout);
    action.responseTimeout = null;
  }
  
  addLogToRoom(room, `${challenger.name} challenges the block!`, 'challenge');
  
  const hasCard = blocker.influences.some(inf => !inf.revealed && inf.card === action.blockCard);
  
  if (hasCard) {
    // Challenge failed - blocker had the card
    addLogToRoom(room, `${blocker.name} reveals the ${action.blockCard}! The block challenge fails.`, 'fail', action.blockCard);
    addLogToRoom(room, `${challenger.name} loses an influence`, 'info');
    
    // Track stats
    if (challenger.gameStats) challenger.gameStats.failedChallenges += 1;
    if (blocker.gameStats) {
      blocker.gameStats.claimsDefended += 1; // Successfully defended block claim
      
      // Track block-specific stats
      if (action.action === 'steal') {
        blocker.gameStats.stealsBlocked += 1;
      } else if (action.action === 'assassinate') {
        blocker.gameStats.contessaSucceeded += 1;
      } else if (action.action === 'foreignAid') {
        blocker.gameStats.foreignaidblockSucceeded += 1;
      }
    }
    
    // Track stats for original actor whose action was blocked
    const originalActor = getPlayerById(room, action.playerId);
    if (originalActor && originalActor.gameStats) {
      if (action.action === 'foreignAid') {
        originalActor.gameStats.foreignaidDenied += 1;
      } else if (action.action === 'assassinate') {
        originalActor.gameStats.assassinationsFailed += 1;
      }
    }
    
    loseInfluence(room, challenger.id, 1, action.blockerId);
    
    // Return and redraw card
    const cardIndex = blocker.influences.findIndex(inf => !inf.revealed && inf.card === action.blockCard);
    if (cardIndex !== -1 && room.deck.length > 0) {
      blocker.influences[cardIndex].card = room.deck.pop();
      room.deck.unshift(action.blockCard);
      room.deck.sort(() => Math.random() - 0.5);
      addLogToRoom(room, `${blocker.name} returns the card and draws a new one`, 'info');
    }
    
    if (action.action === 'foreignAid') {
      addLogToRoom(room, `The block stands. Foreign Aid is blocked!`, 'success', action.blockCard);
    } else {
      addLogToRoom(room, `The block stands. The action is blocked!`, 'success', action.blockCard);
    }
    clearActionAndTimeout(room);
    nextTurn(room);
  } else {
    // Challenge succeeded - blocker was bluffing
    addLogToRoom(room, `${blocker.name} doesn't have the ${action.blockCard}! The block challenge succeeds.`, 'success', action.blockCard);
    addLogToRoom(room, `${blocker.name} loses an influence and the action proceeds`, 'info');
    
    // Track stats
    if (challenger.gameStats) challenger.gameStats.successfulChallenges += 1;
    if (blocker.gameStats) {
      blocker.gameStats.bluffsCaught += 1; // Caught bluffing on block
      
      // Track specific block failures
      if (action.action === 'assassinate' && action.blockCard === 'Contessa') {
        blocker.gameStats.contessaFailed += 1;
      } else if (action.action === 'foreignAid' && action.blockCard === 'Duke') {
        blocker.gameStats.foreignaidblockFailed += 1;
      }
    }
    
    loseInfluence(room, action.blockerId, 1, challenger.id);
    
    // Log the successful action before resolving
    const originalAction = action.action;
    if (originalAction === 'foreignAid') {
      addLogToRoom(room, `Foreign Aid proceeds`, 'success', 'ForeignAid');
    } else if (originalAction === 'assassinate') {
      addLogToRoom(room, `The assassination proceeds`, 'success', 'Assassin');
    } else if (originalAction === 'steal') {
      addLogToRoom(room, `The steal proceeds`, 'success', 'Captain');
    }
    
    resolveAction(room);
  }
  
  return { success: true };
}

function resolveAction(room) {
  const action = room.actionInProgress;
  if (!action) {
    return;
  }

  const actionData = ACTIONS[action.action];
  const actor = getPlayerById(room, action.playerId);
  const target = action.targetId ? getPlayerById(room, action.targetId) : null;

  // Track successful bluffs for challengeable actions that weren't challenged
  if (actionData.challengeable && actionData.card) {
    const hasCard = actor.influences.some(inf => !inf.revealed && inf.card === actionData.card);
    if (!hasCard && actor.gameStats) {
      // They didn't have the card but weren't challenged - successful bluff!
      actor.gameStats.bluffsSucceeded += 1;
    } else if (hasCard && actor.gameStats) {
      // They had the card and weren't challenged - successful claim defense
      actor.gameStats.claimsDefended += 1;
    }
  }

  // Apply costs
  if (actionData.cost) {
    actor.coins -= actionData.cost;
    if (actor.gameStats) actor.gameStats.coinsSpent += actionData.cost;
  }

  // Apply effects
  switch (action.action) {
    case 'income':
      actor.coins += 1;
      if (actor.gameStats) actor.gameStats.coinsEarned += 1;
      if (actor.gameStats) actor.gameStats.incomeTaken += 1;
      if (actor.gameStats) actor.gameStats.actionsPerformed += 1;
      addLogToRoom(room, `${actor.name} takes Income and receives 1 coin`, 'success', 'Income');
      break;
    case 'foreignAid':
      actor.coins += 2;
      if (actor.gameStats) actor.gameStats.coinsEarned += 2;
      if (actor.gameStats) actor.gameStats.foreignaidAccepted += 1;
      if (actor.gameStats) actor.gameStats.actionsPerformed += 1;
      addLogToRoom(room, `${actor.name} receives 2 coins from Foreign Aid`, 'success', 'ForeignAid');
      break;
    case 'tax':
      actor.coins += 3;
      if (actor.gameStats) actor.gameStats.coinsEarned += 3;
      if (actor.gameStats) actor.gameStats.taxSucceeded += 1;
      if (actor.gameStats) actor.gameStats.actionsPerformed += 1;
      addLogToRoom(room, `${actor.name} receives 3 coins from Tax`, 'success', 'Duke');
      break;
    case 'steal':
      if (target) {
        const stolen = Math.min(2, target.coins);
        target.coins -= stolen;
        actor.coins += stolen;
        if (actor.gameStats) actor.gameStats.coinsEarned += stolen;
        if (actor.gameStats) actor.gameStats.coinsStolen += stolen;
        if (target.gameStats) target.gameStats.coinsLost += stolen;
        if (actor.gameStats) actor.gameStats.actionsPerformed += 1;
        addLogToRoom(room, `${actor.name} steals ${stolen} coin${stolen !== 1 ? 's' : ''} from ${target.name}`, 'success', 'Captain');
      }
      break;
    case 'assassinate':
      if (target) {
        if (actor.gameStats) actor.gameStats.assassinationsSucceeded += 1;
        if (actor.gameStats) actor.gameStats.actionsPerformed += 1;
        addLogToRoom(room, `${target.name} must lose an influence`, 'info');
        loseInfluence(room, target.id, 1, action.playerId);
      }
      break;
    case 'exchange':
      // Draw cards from deck based on game mode
      if (actor.gameStats) actor.gameStats.actionsPerformed += 1;
      if (room.useInquisitor) {
        // Inquisitor mode: draw 1 card, choose 1 to keep
        if (room.deck.length >= 1) {
          const drawnCards = [room.deck.pop()];
          actor.exchangeCards = drawnCards;
          actor.mustChooseExchange = true;
          addLogToRoom(room, `${actor.name} draws 1 card to exchange`, 'info', 'Inquisitor');
          room.actionInProgress = null;
          emitToRoom(room.code, 'gameState');
          return;
        }
      } else {
        // Ambassador mode: draw 2 cards, choose 2 to keep
        if (room.deck.length >= 2) {
          const drawnCards = [room.deck.pop(), room.deck.pop()];
          actor.exchangeCards = drawnCards;
          actor.mustChooseExchange = true;
          addLogToRoom(room, `${actor.name} draws 2 cards to exchange`, 'info', 'Ambassador');
          room.actionInProgress = null;
          emitToRoom(room.code, 'gameState');
          return;
        }
      }
      addLogToRoom(room, `${actor.name} exchanges cards (not enough cards in deck)`, 'info');
      break;
    case 'examine':
      // Inquisitor power: look at another player's card and optionally force exchange
      if (actor.gameStats) actor.gameStats.actionsPerformed += 1;
      if (target) {
        const unrevealedCards = target.influences.filter(inf => !inf.revealed);
        if (unrevealedCards.length > 0) {
          actor.examineTargetId = target.id;
          actor.mustChooseExamine = true;
          target.mustShowCardToExaminer = true;
          target.examinedBy = actor.id;
          addLogToRoom(room, `${target.name} must show a card to ${actor.name}`, 'info', 'Inquisitor');
          room.actionInProgress = null;
          emitToRoom(room.code, 'gameState');
          return;
        } else {
          addLogToRoom(room, `${target.name} has no cards to examine`, 'info');
        }
      }
      break;
    case 'coup':
      if (target) {
        if (actor.gameStats) actor.gameStats.actionsPerformed += 1;
        if (actor.gameStats) actor.gameStats.coupsEnacted += 1;
        addLogToRoom(room, `${actor.name} launches a Coup against ${target.name} who must lose an influence`, 'info', 'Coup');
        loseInfluence(room, target.id, 1, actor.id);
      }
      break;
  }

  clearActionAndTimeout(room);
  nextTurn(room);
}

function loseInfluence(room, playerId, count = 1, causedByPlayerId = null) {
  const player = getPlayerById(room, playerId);
  if (!player) return;

  const unrevealed = player.influences.filter(inf => !inf.revealed);
  if (unrevealed.length > 0) {
    // Set how many influences need to be lost
    player.influencesToLose = (player.influencesToLose || 0) + count;
    player.mustRevealInfluence = true;
    player.influenceLossCausedBy = causedByPlayerId; // Track who caused this
    emitToRoom(room.code, 'gameState');
  }
}

function completeExchange(room, playerId, keepIndices) {
  const player = getPlayerById(room, playerId);
  if (!player || !player.mustChooseExchange) {
    return { success: false, error: 'Not in exchange mode' };
  }

  const totalCards = player.influences.length + player.exchangeCards.length;
  const cardsToKeep = player.influences.length; // Keep same number as current influences

  if (!Array.isArray(keepIndices) || keepIndices.length !== cardsToKeep) {
    return { success: false, error: `Must choose exactly ${cardsToKeep} cards to keep` };
  }

  // Combine current influences and drawn cards into a uniform format
  const allCards = [
    ...player.influences, // These are already objects with {card, revealed}
    ...player.exchangeCards.map(card => ({ card, revealed: false })) // Convert drawn cards to objects
  ];
  
  // Validate indices
  if (keepIndices.some(idx => idx < 0 || idx >= allCards.length)) {
    return { success: false, error: 'Invalid card indices' };
  }

  // Keep the selected cards
  const keptCards = keepIndices.map(idx => allCards[idx]);
  
  // Return the rest to deck (just the card names)
  const returnedCards = allCards
    .filter((_, idx) => !keepIndices.includes(idx))
    .map(cardObj => cardObj.card);
  room.deck.push(...returnedCards);
  room.deck.sort(() => Math.random() - 0.5);

  // Update player's influences
  player.influences = keptCards;
  player.exchangeCards = null;
  player.mustChooseExchange = false;

  // Track stat
  if (player.gameStats) {
    player.gameStats.influenceExchanged += 1;
  }

  const card = room.useInquisitor ? 'Inquisitor' : 'Ambassador';
  addLogToRoom(room, `${player.name} completes the exchange`, 'success', card);
  nextTurn(room);

  return { success: true };
}

function showCardToExaminer(room, playerId, cardIndex) {
  const player = getPlayerById(room, playerId);
  if (!player || !player.mustShowCardToExaminer) {
    return { success: false, error: 'Not required to show card' };
  }

  if (cardIndex < 0 || cardIndex >= player.influences.length) {
    return { success: false, error: 'Invalid card index' };
  }

  const influence = player.influences[cardIndex];
  if (influence.revealed) {
    return { success: false, error: 'Cannot show revealed card' };
  }

  // Store the shown card on the examiner
  const examiner = getPlayerById(room, player.examinedBy);
  if (examiner) {
    examiner.examinedCard = influence.card;
    examiner.examinedCardIndex = cardIndex;
  }

  player.mustShowCardToExaminer = false;
  player.examinedBy = null;

  addLogToRoom(room, `${player.name} shows a card to ${examiner.name}`, 'info', 'Inquisitor');

  return { success: true };
}

function completeExamine(room, playerId, forceExchange) {
  const player = getPlayerById(room, playerId);
  if (!player || !player.mustChooseExamine) {
    return { success: false, error: 'Not in examine mode' };
  }

  const target = getPlayerById(room, player.examineTargetId);
  if (!target) {
    return { success: false, error: 'Target not found' };
  }

  // Track examine stat
  if (player.gameStats) {
    player.gameStats.influenceExamined += 1;
  }

  if (forceExchange && room.deck.length > 0 && player.examinedCardIndex !== undefined) {
    // Force target to exchange the specific card that was shown
    const cardIndex = player.examinedCardIndex;
    if (cardIndex !== -1 && !target.influences[cardIndex].revealed) {
      const oldCard = target.influences[cardIndex].card;
      target.influences[cardIndex].card = room.deck.pop();
      room.deck.push(oldCard);
      room.deck.sort(() => Math.random() - 0.5);
      
      // Track forced exchange stat
      if (player.gameStats) {
        player.gameStats.influenceForced += 1;
      }
      
      addLogToRoom(room, `${player.name} forces ${target.name} to exchange their card`, 'info', 'Inquisitor');
    }
  } else {
    addLogToRoom(room, `${player.name} allows ${target.name} to keep their card`, 'info', 'Inquisitor');
  }

  player.examineTargetId = null;
  player.mustChooseExamine = false;
  player.examinedCard = null;
  player.examinedCardIndex = null;
  nextTurn(room);

  return { success: true };
}

function revealInfluence(room, playerId, cardIndex) {
  const player = getPlayerById(room, playerId);
  if (!player || !player.mustRevealInfluence) {
    return { success: false, error: 'Not required to reveal influence' };
  }

  if (cardIndex < 0 || cardIndex >= player.influences.length) {
    return { success: false, error: 'Invalid card index' };
  }

  const influence = player.influences[cardIndex];
  if (influence.revealed) {
    return { success: false, error: 'Card already revealed' };
  }

  influence.revealed = true;
  player.influencesToLose = (player.influencesToLose || 1) - 1;
  
  // Track stat
  if (player.gameStats) player.gameStats.influencesLost += 1;
  
  addLogToRoom(room, `${player.name} reveals and loses their ${influence.card}`, 'info', influence.card);

  const stillAlive = player.influences.some(inf => !inf.revealed);
  if (!stillAlive) {
    player.alive = false;
    player.mustRevealInfluence = false;
    player.influencesToLose = 0;
    
    // Track elimination order (lower placement = eliminated earlier)
    const alivePlayers = room.players.filter(p => p.alive && p.id !== player.id).length;
    const placement = alivePlayers + 1; // +1 because this player just died
    const eliminationEntry = {
      playerId: player.id,
      playerName: player.name,
      userId: player.userId,
      username: player.username,
      coinsEarned: player.gameStats?.coinsEarned || 0,
      eliminations: player.gameStats?.playersEliminated || 0,
      placement: placement
    };
    room.eliminationOrder.push(eliminationEntry);
    
    // Track who eliminated this player
    if (player.influenceLossCausedBy) {
      const eliminator = getPlayerById(room, player.influenceLossCausedBy);
      if (eliminator && eliminator.gameStats) {
        eliminator.gameStats.playersEliminated += 1;
      }
    }
    
    addLogToRoom(room, `${player.name} is eliminated from the game!`, 'info');
    checkWinCondition(room);
    return { success: true };
  }

  // Check if more influences need to be lost
  if (player.influencesToLose > 0) {
    // Keep mustRevealInfluence = true
    return { success: true };
  }

  // All influences revealed
  player.mustRevealInfluence = false;

  // Check if there are other players waiting to reveal
  const othersWaiting = room.players.some(p => p.mustRevealInfluence);
  if (!othersWaiting) {
    // All reveals complete, continue game
    if (room.actionInProgress) {
      room.actionInProgress = null;
    }
    nextTurn(room);
  }

  return { success: true };
}

function checkWinCondition(room) {
  const alivePlayers = room.players.filter(p => p.alive);
  if (alivePlayers.length === 1) {
    const winner = alivePlayers[0];
    room.gameEndTime = new Date();
    room.winnerId = winner.id;
    room.winnerUserId = winner.userId; // Track user ID for stats
    
    // Add winner to elimination order (placement 1)
    room.eliminationOrder.push({
      playerId: winner.id,
      playerName: winner.name,
      userId: winner.userId,
      username: winner.username,
      coinsEarned: winner.gameStats?.coinsEarned || 0,
      eliminations: winner.gameStats?.playersEliminated || 0,
      placement: 1
    });
    
    // Sort by placement (ascending - 1st, 2nd, 3rd, etc.)
    room.eliminationOrder.sort((a, b) => a.placement - b.placement);
    
    addLogToRoom(room, `ðŸŽ‰ ${winner.name} wins the game! ðŸŽ‰`, 'success');
    room.state = 'ended';
    
    // Save game results to database
    saveGameResults(room);
    
    emitToRoom(room.code, 'gameEnded', { 
      winner: winner.name,
      winnerId: winner.id,
      winnerUserId: winner.userId,
      gameStats: room.eliminationOrder
    });
  }
}

/**
 * Calculate Elo rating changes using standard chess formula
 * For multiplayer games, we compare each player against all others
 */
function calculateEloChanges(players, winnerId) {
  const K_FACTOR = 32; // Standard chess K-factor
  const eloChanges = {};
  
  // Get all authenticated players with current Elo
  const authPlayers = players.filter(p => p.userId && p.stats);
  
  if (authPlayers.length < 2) {
    // Not enough authenticated players to calculate Elo
    return eloChanges;
  }
  
  authPlayers.forEach(player => {
    let totalExpected = 0;
    let totalActual = 0;
    let opponentCount = 0;
    
    // Compare against each other authenticated player
    authPlayers.forEach(opponent => {
      if (player.userId === opponent.userId) return;
      
      const playerElo = player.stats.elo_rating || 1200;
      const opponentElo = opponent.stats.elo_rating || 1200;
      
      // Calculate expected score against this opponent
      const expected = 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400));
      totalExpected += expected;
      
      // Calculate actual score
      // Win = 1, Loss = 0, but in multiplayer we use placement
      if (player.id === winnerId) {
        totalActual += 1; // Winner gets full point against everyone
      } else if (opponent.id === winnerId) {
        totalActual += 0; // Loser against winner gets 0
      } else {
        // Both lost - use influence count as tiebreaker
        const playerInfluences = player.influences.filter(i => !i.revealed).length;
        const opponentInfluences = opponent.influences.filter(i => !i.revealed).length;
        if (playerInfluences > opponentInfluences) {
          totalActual += 0.75; // Placed better
        } else if (playerInfluences < opponentInfluences) {
          totalActual += 0.25; // Placed worse
        } else {
          totalActual += 0.5; // Tied
        }
      }
      
      opponentCount++;
    });
    
    if (opponentCount > 0) {
      // Average the expected and actual scores
      const avgExpected = totalExpected / opponentCount;
      const avgActual = totalActual / opponentCount;
      
      // Calculate Elo change
      const eloChange = Math.round(K_FACTOR * (avgActual - avgExpected));
      const currentElo = player.stats.elo_rating || 1200;
      const newElo = Math.max(100, currentElo + eloChange); // Minimum Elo of 100
      
      eloChanges[player.userId] = {
        oldElo: currentElo,
        newElo: newElo,
        change: eloChange
      };
    }
  });
  
  return eloChanges;
}

/**
 * Save game results to database
 */
function saveGameResults(room) {
  try {
    if (!room.gameStartTime || !room.gameEndTime) {
      return;
    }
    
    // Skip stats for unranked games
    if (room.ranked === false) {
      return;
    }
    
    const duration = Math.floor((room.gameEndTime - room.gameStartTime) / 1000); // seconds
    const winner = room.players.find(p => p.id === room.winnerId);
    
    // Calculate Elo changes
    const eloChanges = calculateEloChanges(room.players, room.winnerId);
    
    // Update stats for each authenticated player
    room.players.forEach(player => {
      if (!player.userId || !player.gameStats) return;
      
      const isWinner = player.id === room.winnerId;
      const eloChange = eloChanges[player.userId];
      
      // Update user_stats
      const updateStats = db.prepare(`
        UPDATE user_stats
        SET games_played = games_played + 1,
            games_won = games_won + ?,
            elo_rating = ?,
            
            influences_lost = influences_lost + ?,
            income_taken = income_taken + ?,
            coups_enacted = coups_enacted + ?,
            players_eliminated = players_eliminated + ?,
            successful_challenges = successful_challenges + ?,
            failed_challenges = failed_challenges + ?,
            claims_defended = claims_defended + ?,
            bluffs_caught = bluffs_caught + ?,
            bluffs_succeeded = bluffs_succeeded + ?,
            
            coins_earned = coins_earned + ?,
            coins_spent = coins_spent + ?,
            coins_lost = coins_lost + ?,
            coins_stolen = coins_stolen + ?,
            
            tax_succeeded = tax_succeeded + ?,
            tax_failed = tax_failed + ?,
            foreignaid_accepted = foreignaid_accepted + ?,
            foreignaid_denied = foreignaid_denied + ?,
            foreignaidblock_succeeded = foreignaidblock_succeeded + ?,
            foreignaidblock_failed = foreignaidblock_failed + ?,
            steals_blocked = steals_blocked + ?,
            
            assassinations_succeeded = assassinations_succeeded + ?,
            assassinations_failed = assassinations_failed + ?,
            contessa_succeeded = contessa_succeeded + ?,
            contessa_failed = contessa_failed + ?,
            
            influence_exchanged = influence_exchanged + ?,
            influence_examined = influence_examined + ?,
            influence_forced = influence_forced + ?
        WHERE user_id = ?
      `);
      
      updateStats.run(
        isWinner ? 1 : 0,
        eloChange ? eloChange.newElo : (player.stats.elo_rating || 1200),
        
        player.gameStats.influencesLost,
        player.gameStats.incomeTaken,
        player.gameStats.coupsEnacted,
        player.gameStats.playersEliminated,
        player.gameStats.successfulChallenges,
        player.gameStats.failedChallenges,
        player.gameStats.claimsDefended,
        player.gameStats.bluffsCaught,
        player.gameStats.bluffsSucceeded,
        
        player.gameStats.coinsEarned,
        player.gameStats.coinsSpent,
        player.gameStats.coinsLost,
        player.gameStats.coinsStolen,
        
        player.gameStats.taxSucceeded,
        player.gameStats.taxFailed,
        player.gameStats.foreignaidAccepted,
        player.gameStats.foreignaidDenied,
        player.gameStats.foreignaidblockSucceeded,
        player.gameStats.foreignaidblockFailed,
        player.gameStats.stealsBlocked,
        
        player.gameStats.assassinationsSucceeded,
        player.gameStats.assassinationsFailed,
        player.gameStats.contessaSucceeded,
        player.gameStats.contessaFailed,
        
        player.gameStats.influenceExchanged,
        player.gameStats.influenceExamined,
        player.gameStats.influenceForced,
        
        player.userId
      );
      
      db.saveDatabase();
    });
    
    // Prepare player data for game history
    const playerData = room.players.map(p => ({
      id: p.id,
      userId: p.userId || null,
      username: p.username || null,
      name: p.name,
      isGuest: p.isGuest,
      finalCoins: p.coins,
      influencesRemaining: p.influences.filter(i => !i.revealed).length,
      gameStats: p.gameStats,
      eloChange: eloChanges[p.userId]?.change || null
    }));
    
    // Save to game_history
    const insertHistory = db.prepare(`
      INSERT INTO game_history 
      (room_code, winner_user_id, player_data, game_settings, started_at, ended_at, duration_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    const gameSettings = {
      useInquisitor: room.useInquisitor,
      allowSpectators: room.allowSpectators,
      chatMode: room.chatMode,
      playerCount: room.players.length
    };
    
    insertHistory.run(
      room.code,
      winner?.userId || null,
      JSON.stringify(playerData),
      JSON.stringify(gameSettings),
      room.gameStartTime.toISOString(),
      room.gameEndTime.toISOString(),
      duration
    );
    
    db.saveDatabase();
    
  } catch (error) {
    console.error('Error saving game results:', error);
  }
}

function nextTurn(room) {
  // Check if anyone is still choosing cards for exchange
  const someoneExchanging = room.players.some(p => p.mustChooseExchange);
  if (someoneExchanging) {
    return;
  }

  // Check if anyone needs to reveal an influence
  const someoneRevealing = room.players.some(p => p.mustRevealInfluence);
  if (someoneRevealing) {
    return;
  }

  // Check if anyone needs to show a card to an examiner
  const someoneShowingCard = room.players.some(p => p.mustShowCardToExaminer);
  if (someoneShowingCard) {
    return;
  }

  let next = (room.currentPlayerIndex + 1) % room.players.length;
  let attempts = 0;
  
  while (!room.players[next].alive && attempts < room.players.length) {
    next = (next + 1) % room.players.length;
    attempts++;
  }
  
  room.currentPlayerIndex = next;
  addLogToRoom(room, `--- ${room.players[next].name}'s turn ---`, 'info');
}

function switchToPlayer(room, socketId, name, persistentPlayerId, authenticatedUser = null) {
  const spectator = getSpectatorBySocketId(room, socketId);
  if (!spectator) {
    return { success: false, error: 'Spectator not found' };
  }

  if (room.players.length >= 6) {
    return { success: false, error: 'Game is full (6 players max)' };
  }

  if (room.state !== 'lobby') {
    return { success: false, error: 'Cannot join as player during active game' };
  }

  // Remove from spectators
  room.spectators = room.spectators.filter(s => s.socketId !== socketId);

  // Fetch stats if authenticated
  let stats = null;
  if (authenticatedUser && authenticatedUser.stats) {
    stats = authenticatedUser.stats;
  }

  // Add to players
  const player = {
    id: persistentPlayerId || socketId,
    persistentId: persistentPlayerId || socketId,
    socketId: socketId,
    name: authenticatedUser ? authenticatedUser.username : (name || spectator.name),
    userId: authenticatedUser ? authenticatedUser.id : null,
    username: authenticatedUser ? authenticatedUser.username : null,
    isGuest: !authenticatedUser,
    stats: stats,
    coins: 2,
    influences: [],
    alive: true,
    disconnected: false
  };

  room.players.push(player);

  return { success: true };
}

function switchToSpectator(room, socketId) {
  const player = getPlayerBySocketId(room, socketId);
  if (!player) {
    return { success: false, error: 'Player not found' };
  }

  if (!room.allowSpectators) {
    return { success: false, error: 'Spectators not allowed in this room' };
  }

  if (room.state !== 'lobby') {
    return { success: false, error: 'Cannot switch to spectator during active game' };
  }

  // Remove from players
  room.players = room.players.filter(p => p.socketId !== socketId);

  // Add to spectators
  const spectator = {
    id: socketId,
    socketId: socketId,
    name: player.name
  };

  room.spectators.push(spectator);

  return { success: true };
}

// ==========================================
// PROFILE & LEADERBOARD API ROUTES
// ==========================================

// Helper: Calculate playstyle archetype
function calculatePlaystyle(stats) {
  const archetypes = [];
  const gamesPlayed = stats.games_played || 1;
  
  // Aggressive Archetypes
  
  // The Hit Man (assassinate specialist - very high assassination rate)
  if (stats.assassinations_succeeded > gamesPlayed * 1.2) {
    archetypes.push({
      name: 'The Hit Man',
      icon: '🎯',
      description: 'Professional eliminator, strikes with deadly precision',
      score: (stats.assassinations_succeeded / gamesPlayed) * 10
    });
  }
  
  // The Warlord (high eliminations overall)
  if (stats.players_eliminated > gamesPlayed * 2.5) {
    archetypes.push({
      name: 'The Warlord',
      icon: '⚔️',
      description: 'Leaves a trail of fallen opponents',
      score: (stats.players_eliminated / gamesPlayed) * 8
    });
  }
  
  // The Brute (coup specialist)
  if (stats.coups_enacted > gamesPlayed * 1.0) {
    archetypes.push({
      name: 'The Brute',
      icon: '💪',
      description: 'Solves problems with overwhelming force',
      score: (stats.coups_enacted / gamesPlayed) * 9
    });
  }
  
  // The Phantom (stealthy assassin - high assassinations, low coups)
  if (stats.assassinations_succeeded > stats.coups_enacted * 2 && stats.assassinations_succeeded > gamesPlayed * 0.7) {
    archetypes.push({
      name: 'The Phantom',
      icon: '👻',
      description: 'Strikes from the shadows, avoids direct confrontation',
      score: (stats.assassinations_succeeded / (stats.coups_enacted + 1)) * 7
    });
  }
  
  // Deception Archetypes
  
  // The Master of Lies (extremely high bluff rate)
  if (stats.bluffs_succeeded > gamesPlayed * 3) {
    archetypes.push({
      name: 'The Master of Lies',
      icon: '🃏',
      description: 'Weaves intricate webs of deception',
      score: (stats.bluffs_succeeded / gamesPlayed) * 11
    });
  }
  
  // The Deceiver (high bluffs)
  if (stats.bluffs_succeeded > gamesPlayed * 1.5) {
    archetypes.push({
      name: 'The Deceiver',
      icon: '🎭',
      description: 'Master of misdirection and false claims',
      score: (stats.bluffs_succeeded / gamesPlayed) * 8
    });
  }
  
  // The Gambler (bluffs often but gets caught sometimes)
  const totalBluffAttempts = stats.bluffs_succeeded + stats.bluffs_caught;
  if (totalBluffAttempts > gamesPlayed * 2 && stats.bluffs_caught > gamesPlayed * 0.5) {
    archetypes.push({
      name: 'The Gambler',
      icon: '🎲',
      description: 'Takes big risks, wins big or loses big',
      score: (totalBluffAttempts / gamesPlayed) * 6
    });
  }
  
  // Honesty Archetypes
  
  // The Truth Teller (rarely bluffs, high claims defended)
  const honestyRatio = stats.claims_defended / (stats.bluffs_succeeded + 1);
  if (honestyRatio > 2 && stats.claims_defended > gamesPlayed) {
    archetypes.push({
      name: 'The Truth Teller',
      icon: '⚖️',
      description: 'Rarely bluffs, earns trust through honesty',
      score: honestyRatio * 7
    });
  }
  
  // The Saint (extremely honest, very low bluff rate)
  if (stats.bluffs_succeeded < gamesPlayed * 0.3 && stats.claims_defended > gamesPlayed * 1.5) {
    archetypes.push({
      name: 'The Saint',
      icon: '😇',
      description: 'Plays with unwavering integrity',
      score: (stats.claims_defended / (stats.bluffs_succeeded + 1)) * 10
    });
  }
  
  // Challenge Archetypes
  
  // The Detective (high challenge accuracy)
  const challengeAccuracy = (stats.successful_challenges + stats.failed_challenges) > 0
    ? stats.successful_challenges / (stats.successful_challenges + stats.failed_challenges)
    : 0;
  if (challengeAccuracy > 0.7 && stats.successful_challenges > gamesPlayed * 0.8) {
    archetypes.push({
      name: 'The Detective',
      icon: '🔍',
      description: 'Spots lies with uncanny accuracy',
      score: challengeAccuracy * stats.successful_challenges
    });
  }
  
  // The Skeptic (challenges often)
  if ((stats.successful_challenges + stats.failed_challenges) > gamesPlayed * 1.5) {
    archetypes.push({
      name: 'The Skeptic',
      icon: '🤔',
      description: 'Questions everything and everyone',
      score: ((stats.successful_challenges + stats.failed_challenges) / gamesPlayed) * 6
    });
  }
  
  // Economic Archetypes
  
  // The Tax Collector (duke specialist)
  if (stats.tax_succeeded > gamesPlayed * 2.5) {
    archetypes.push({
      name: 'The Tax Collector',
      icon: '👑',
      description: 'Controls the economy through taxation',
      score: (stats.tax_succeeded / gamesPlayed) * 9
    });
  }
  
  // The Economist (high coins earned overall)
  if (stats.coins_earned > gamesPlayed * 20) {
    archetypes.push({
      name: 'The Economist',
      icon: '💼',
      description: 'Builds wealth through strategic accumulation',
      score: (stats.coins_earned / gamesPlayed) / 3
    });
  }
  
  // The Thief (captain specialist)
  if (stats.coins_stolen > gamesPlayed * 6) {
    archetypes.push({
      name: 'The Thief',
      icon: '🦹',
      description: 'Takes what belongs to others',
      score: (stats.coins_stolen / gamesPlayed) * 8
    });
  }
  
  // The Miser (takes income often)
  if (stats.income_taken > gamesPlayed * 5 && stats.coups_enacted + stats.assassinations_succeeded < gamesPlayed * 0.5) {
    archetypes.push({
      name: 'The Miser',
      icon: '🪙',
      description: 'Hoards coins carefully, avoids spending',
      score: (stats.income_taken / gamesPlayed) * 7
    });
  }
  
  // Defensive Archetypes
  
  // The Guardian (blocks often)
  const totalBlocks = stats.steals_blocked + stats.contessa_succeeded + stats.foreignaidblock_succeeded;
  if (totalBlocks > gamesPlayed * 1.5) {
    archetypes.push({
      name: 'The Guardian',
      icon: '🛡️',
      description: 'Protects themselves and disrupts opponents',
      score: (totalBlocks / gamesPlayed) * 8
    });
  }
  
  // The Diplomat (foreign aid specialist)
  if (stats.foreignaid_accepted > gamesPlayed * 2 && stats.foreignaidblock_succeeded > gamesPlayed * 0.5) {
    archetypes.push({
      name: 'The Diplomat',
      icon: '🤝',
      description: 'Navigates politics and blocks aid strategically',
      score: ((stats.foreignaid_accepted + stats.foreignaidblock_succeeded) / gamesPlayed) * 6
    });
  }
  
  // The Survivor (low death rate, decent win rate)
  const survivalRatio = gamesPlayed / (stats.influences_lost + 1);
  if (survivalRatio > 0.8 && stats.games_won > gamesPlayed * 0.2) {
    archetypes.push({
      name: 'The Survivor',
      icon: '🧗',
      description: 'Outlasts opponents through careful play',
      score: survivalRatio * 8
    });
  }
  
  // Performance Archetypes
  
  // The Champion (high win rate)
  const winRate = stats.games_won / gamesPlayed;
  if (winRate > 0.5 && stats.games_played >= 10) {
    archetypes.push({
      name: 'The Champion',
      icon: '🏆',
      description: 'Dominates the competition consistently',
      score: winRate * 15
    });
  }
  
  // The Finisher (high eliminations per win)
  const finishingPower = stats.games_won > 0 ? stats.players_eliminated / stats.games_won : 0;
  if (finishingPower > 2.5) {
    archetypes.push({
      name: 'The Finisher',
      icon: '⚡',
      description: 'Closes out games with lethal precision',
      score: finishingPower * 7
    });
  }
  
  // The Underdog (wins despite losses)
  if (winRate > 0.2 && winRate < 0.4 && stats.games_played >= 15) {
    archetypes.push({
      name: 'The Underdog',
      icon: '🐕',
      description: 'Pulls off unlikely victories',
      score: stats.games_won * 2
    });
  }
  
  // Balanced Archetypes
  
  // The Strategist (balanced stats across the board)
  const balanceScore = (
    (stats.tax_succeeded > gamesPlayed * 0.5 ? 1 : 0) +
    (stats.assassinations_succeeded > gamesPlayed * 0.3 ? 1 : 0) +
    (stats.bluffs_succeeded > gamesPlayed * 0.5 ? 1 : 0) +
    (stats.successful_challenges > gamesPlayed * 0.3 ? 1 : 0) +
    (totalBlocks > gamesPlayed * 0.5 ? 1 : 0)
  );
  if (balanceScore >= 4 && stats.games_played >= 10) {
    archetypes.push({
      name: 'The Strategist',
      icon: '♟️',
      description: 'Adapts tactics to any situation',
      score: balanceScore * 4
    });
  }
  
  // The Wildcard (unpredictable stats)
  const varianceScore = Math.abs(stats.coups_enacted - stats.assassinations_succeeded) +
                        Math.abs(stats.bluffs_succeeded - stats.claims_defended);
  if (varianceScore > gamesPlayed * 2 && stats.games_played >= 8) {
    archetypes.push({
      name: 'The Wildcard',
      icon: '🌪️',
      description: 'Unpredictable and impossible to read',
      score: (varianceScore / gamesPlayed) * 5
    });
  }
  
  // Conservative Archetype
  
  // The Pacifist (avoids violence)
  const violenceScore = stats.coups_enacted + stats.assassinations_succeeded;
  if (violenceScore < gamesPlayed * 0.5 && stats.games_played >= 5) {
    archetypes.push({
      name: 'The Pacifist',
      icon: '☮️',
      description: 'Wins through patience, not aggression',
      score: gamesPlayed / (violenceScore + 1) * 6
    });
  }
  
  // Sort by score and return top archetype
  archetypes.sort((a, b) => b.score - a.score);
  
  // Return top archetype or default
  return archetypes[0] || {
    name: 'The Novice',
    icon: '🌱',
    description: 'Still learning the ways of the coup',
    score: 0
  };
}

// Helper: Calculate achievements
function calculateAchievements(stats) {
  const achievements = [];
  
  // === DUKE ACHIEVEMENTS (Tax) ===
  achievements.push({
    id: 'dukes_decree',
    name: "Duke's Decree",
    icon: '💎',
    description: 'Collected tax 25 times',
    unlocked: stats.tax_succeeded >= 25,
    progress: stats.tax_succeeded,
    target: 25
  });
  
  achievements.push({
    id: 'dukes_domain',
    name: "Duke's Domain",
    icon: '💎',
    description: 'Collected tax 100 times',
    unlocked: stats.tax_succeeded >= 100,
    progress: stats.tax_succeeded,
    target: 100
  });
  
  achievements.push({
    id: 'dukes_dominion',
    name: "Duke's Dominion",
    icon: '💎',
    description: 'Collected tax 250 times',
    unlocked: stats.tax_succeeded >= 250,
    progress: stats.tax_succeeded,
    target: 250
  });
  
  achievements.push({
    id: 'dukes_domination',
    name: "Duke's Domination",
    icon: '💎',
    description: 'Collected tax 1000 times',
    unlocked: stats.tax_succeeded >= 1000,
    progress: stats.tax_succeeded,
    target: 1000
  });
  
  // === ASSASSIN ACHIEVEMENTS ===
  achievements.push({
    id: 'dishonored',
    name: 'Dishonored',
    icon: '⚔️',
    description: 'Successfully assassinated 25 players',
    unlocked: stats.assassinations_succeeded >= 25,
    progress: stats.assassinations_succeeded,
    target: 25
  });
  
  achievements.push({
    id: 'hitman',
    name: 'Hitman',
    icon: '⚔️',
    description: 'Successfully assassinated 100 players',
    unlocked: stats.assassinations_succeeded >= 100,
    progress: stats.assassinations_succeeded,
    target: 100
  });
  
  achievements.push({
    id: 'mark_of_the_ninja',
    name: 'Mark of the Ninja',
    icon: '⚔️',
    description: 'Successfully assassinated 250 players',
    unlocked: stats.assassinations_succeeded >= 250,
    progress: stats.assassinations_succeeded,
    target: 250
  });
  
  achievements.push({
    id: 'assassins_creed',
    name: "Assassin's Creed",
    icon: '⚔️',
    description: 'Successfully assassinated 1000 players',
    unlocked: stats.assassinations_succeeded >= 1000,
    progress: stats.assassinations_succeeded,
    target: 1000
  });
  
  // === CAPTAIN ACHIEVEMENTS (Coins Stolen) ===
  achievements.push({
    id: 'stickup_artist',
    name: 'Stickup Artist',
    icon: '💰',
    description: 'Stolen 50 coins',
    unlocked: stats.coins_stolen >= 50,
    progress: stats.coins_stolen,
    target: 50
  });
  
  achievements.push({
    id: 'bank_raider',
    name: 'Bank Raider',
    icon: '💰',
    description: 'Stolen 200 coins',
    unlocked: stats.coins_stolen >= 200,
    progress: stats.coins_stolen,
    target: 200
  });
  
  achievements.push({
    id: 'crime_lord',
    name: 'Crime Lord',
    icon: '💰',
    description: 'Stolen 500 coins',
    unlocked: stats.coins_stolen >= 500,
    progress: stats.coins_stolen,
    target: 500
  });
  
  achievements.push({
    id: 'robber_baron',
    name: 'Robber Baron',
    icon: '💰',
    description: 'Stolen 2000 coins',
    unlocked: stats.coins_stolen >= 2000,
    progress: stats.coins_stolen,
    target: 2000
  });
  
  // === AMBASSADOR/INQUISITOR ACHIEVEMENTS (Exchanges) ===
  achievements.push({
    id: 'backroom_dealer',
    name: 'Backroom Dealer',
    icon: '🔄',
    description: 'Successfully exchanged 25 times',
    unlocked: stats.influence_exchanged >= 25,
    progress: stats.influence_exchanged,
    target: 25
  });
  
  achievements.push({
    id: 'court_negotiator',
    name: 'Court Negotiator',
    icon: '🔄',
    description: 'Successfully exchanged 100 times',
    unlocked: stats.influence_exchanged >= 100,
    progress: stats.influence_exchanged,
    target: 100
  });
  
  achievements.push({
    id: 'power_broker',
    name: 'Power Broker',
    icon: '🔄',
    description: 'Successfully exchanged 250 times',
    unlocked: stats.influence_exchanged >= 250,
    progress: stats.influence_exchanged,
    target: 250
  });
  
  achievements.push({
    id: 'architect_of_influence',
    name: 'Architect of Influence',
    icon: '🔄',
    description: 'Successfully exchanged 1000 times',
    unlocked: stats.influence_exchanged >= 1000,
    progress: stats.influence_exchanged,
    target: 1000
  });
  
  // === INQUISITOR ACHIEVEMENTS (Examinations) ===
  achievements.push({
    id: 'confession_extracted',
    name: 'Confession Extracted',
    icon: '🔍',
    description: 'Successfully investigated 25 cards',
    unlocked: stats.influence_examined >= 25,
    progress: stats.influence_examined,
    target: 25
  });
  
  achievements.push({
    id: 'doctrine_enforced',
    name: 'Doctrine Enforced',
    icon: '🔍',
    description: 'Successfully investigated 100 cards',
    unlocked: stats.influence_examined >= 100,
    progress: stats.influence_examined,
    target: 100
  });
  
  achievements.push({
    id: 'eyes_of_the_state',
    name: 'Eyes of the State',
    icon: '🔍',
    description: 'Successfully investigated 250 cards',
    unlocked: stats.influence_examined >= 250,
    progress: stats.influence_examined,
    target: 250
  });
  
  achievements.push({
    id: 'by_divine_scrutiny',
    name: 'By Divine Scrutiny',
    icon: '🔍',
    description: 'Successfully investigated 1000 cards',
    unlocked: stats.influence_examined >= 1000,
    progress: stats.influence_examined,
    target: 1000
  });
  
  // === CONTESSA ACHIEVEMENTS (Assassination Blocks) ===
  achievements.push({
    id: 'death_deferred',
    name: 'Death Deferred',
    icon: '🛡️',
    description: 'Successfully blocked 25 assassination attempts',
    unlocked: stats.contessa_succeeded >= 25,
    progress: stats.contessa_succeeded,
    target: 25
  });
  
  achievements.push({
    id: 'a_ladys_reprieve',
    name: "A Lady's Reprieve",
    icon: '🛡️',
    description: 'Successfully blocked 100 assassination attempts',
    unlocked: stats.contessa_succeeded >= 100,
    progress: stats.contessa_succeeded,
    target: 100
  });
  
  achievements.push({
    id: 'royal_immunity',
    name: 'Royal Immunity',
    icon: '🛡️',
    description: 'Successfully blocked 250 assassination attempts',
    unlocked: stats.contessa_succeeded >= 250,
    progress: stats.contessa_succeeded,
    target: 250
  });
  
  achievements.push({
    id: 'untouched_nobility',
    name: 'Untouched Nobility',
    icon: '🛡️',
    description: 'Successfully blocked 1000 assassination attempts',
    unlocked: stats.contessa_succeeded >= 1000,
    progress: stats.contessa_succeeded,
    target: 1000
  });
  
  // === INCOME ACHIEVEMENTS ===
  achievements.push({
    id: 'dont_spend_it_all_in_one_place',
    name: "Don't Spend It All In One Place",
    icon: '🪙',
    description: 'Collected income 25 times',
    unlocked: stats.income_taken >= 25,
    progress: stats.income_taken,
    target: 25
  });
  
  achievements.push({
    id: 'hard_earned_wages',
    name: 'Hard Earned Wages',
    icon: '🪙',
    description: 'Collected income 100 times',
    unlocked: stats.income_taken >= 100,
    progress: stats.income_taken,
    target: 100
  });
  
  achievements.push({
    id: 'working_overtime',
    name: 'Working Overtime',
    icon: '🪙',
    description: 'Collected income 250 times',
    unlocked: stats.income_taken >= 250,
    progress: stats.income_taken,
    target: 250
  });
  
  achievements.push({
    id: 'working_9_to_5',
    name: 'Working 9 to 5',
    icon: '🪙',
    description: 'Collected income 500 times',
    unlocked: stats.income_taken >= 500,
    progress: stats.income_taken,
    target: 500
  });
  
  achievements.push({
    id: 'honest_living',
    name: 'Honest Living',
    icon: '🪙',
    description: 'Collected income 1000 times',
    unlocked: stats.income_taken >= 1000,
    progress: stats.income_taken,
    target: 1000
  });
  
  // === COUP ACHIEVEMENTS ===
  achievements.push({
    id: 'by_the_books',
    name: 'By the Books',
    icon: '👊',
    description: 'Performed a coup 25 times',
    unlocked: stats.coups_enacted >= 25,
    progress: stats.coups_enacted,
    target: 25
  });
  
  achievements.push({
    id: 'hostile_takeover',
    name: 'Hostile Takeover',
    icon: '👊',
    description: 'Performed a coup 100 times',
    unlocked: stats.coups_enacted >= 100,
    progress: stats.coups_enacted,
    target: 100
  });
  
  achievements.push({
    id: 'storming_the_bastille',
    name: 'Storming the Bastille',
    icon: '👊',
    description: 'Performed a coup 250 times',
    unlocked: stats.coups_enacted >= 250,
    progress: stats.coups_enacted,
    target: 250
  });
  
  achievements.push({
    id: 'coup_detat',
    name: "Coup d'État",
    icon: '👊',
    description: 'Performed a coup 500 times',
    unlocked: stats.coups_enacted >= 500,
    progress: stats.coups_enacted,
    target: 500
  });
  
  achievements.push({
    id: 'coup_de_grace',
    name: 'Coup de Grâce',
    icon: '👊',
    description: 'Performed a coup 1000 times',
    unlocked: stats.coups_enacted >= 1000,
    progress: stats.coups_enacted,
    target: 1000
  });
  
  // === OTHER EXISTING ACHIEVEMENTS ===
  
  // === BLUFFING ACHIEVEMENTS ===
  achievements.push({
    id: 'spinning_the_yarn',
    name: 'Spinning the Yarn',
    icon: '🃏',
    description: 'Successfully bluffed 25 times',
    unlocked: stats.bluffs_succeeded >= 25,
    progress: stats.bluffs_succeeded,
    target: 25
  });
  
  achievements.push({
    id: 'master_bluffer',
    name: 'Master Bluffer',
    icon: '🃏',
    description: 'Successfully bluffed 100 times',
    unlocked: stats.bluffs_succeeded >= 100,
    progress: stats.bluffs_succeeded,
    target: 100
  });
  
  achievements.push({
    id: 'dastardly_deceiver',
    name: 'Dastardly Deceiver',
    icon: '🃏',
    description: 'Successfully bluffed 250 times',
    unlocked: stats.bluffs_succeeded >= 250,
    progress: stats.bluffs_succeeded,
    target: 250
  });
  
  achievements.push({
    id: 'flagrant_falsifier',
    name: 'Flagrant Falsifier',
    icon: '🃏',
    description: 'Successfully bluffed 1000 times',
    unlocked: stats.bluffs_succeeded >= 1000,
    progress: stats.bluffs_succeeded,
    target: 1000
  });
  
  // === WINS ACHIEVEMENTS ===
  achievements.push({
    id: 'the_peoples_champion',
    name: "The People's Champion",
    icon: '👑',
    description: 'Win 10 games',
    unlocked: stats.games_won >= 10,
    progress: stats.games_won,
    target: 10
  });
  
  achievements.push({
    id: 'knight_of_the_realm',
    name: 'Knight of the Realm',
    icon: '👑',
    description: 'Win 25 games',
    unlocked: stats.games_won >= 25,
    progress: stats.games_won,
    target: 25
  });
  
  achievements.push({
    id: 'dont_discount_this_viscount',
    name: "Don't Discount this Viscount",
    icon: '👑',
    description: 'Win 50 games',
    unlocked: stats.games_won >= 50,
    progress: stats.games_won,
    target: 50
  });
  
  achievements.push({
    id: 'my_name_is_earl',
    name: 'My Name is Earl',
    icon: '👑',
    description: 'Win 100 games',
    unlocked: stats.games_won >= 100,
    progress: stats.games_won,
    target: 100
  });
  
  achievements.push({
    id: 'mckee_de_lafayette',
    name: 'McKee de Lafayette',
    icon: '👑',
    description: 'Win 250 games',
    unlocked: stats.games_won >= 250,
    progress: stats.games_won,
    target: 250
  });
  
  achievements.push({
    id: 'prince_of_the_universe',
    name: 'Prince of the Universe',
    icon: '👑',
    description: 'Win 500 games',
    unlocked: stats.games_won >= 500,
    progress: stats.games_won,
    target: 500
  });
  
  achievements.push({
    id: 'god_save_the_queen',
    name: 'God Save the Queen',
    icon: '👑',
    description: 'Win 1000 games',
    unlocked: stats.games_won >= 1000,
    progress: stats.games_won,
    target: 1000
  });
  
  achievements.push({
    id: 'emperor_of_mankind',
    name: 'Emperor of Mankind',
    icon: '👑',
    description: 'Win 2500 games',
    unlocked: stats.games_won >= 2500,
    progress: stats.games_won,
    target: 2500
  });
  
  achievements.push({
    id: 'we_said_it_couldnt_be_done',
    name: "We Said It Couldn't Be Done",
    icon: '👑',
    description: 'Win 5000 games',
    unlocked: stats.games_won >= 5000,
    progress: stats.games_won,
    target: 5000
  });
  
  // === COINS EARNED ACHIEVEMENTS ===
  achievements.push({
    id: 'scrapin_by',
    name: "Scrapin' By",
    icon: '💵',
    description: 'Earned 25 coins',
    unlocked: stats.coins_earned >= 25,
    progress: stats.coins_earned,
    target: 25
  });
  
  achievements.push({
    id: 'buying_for_1_selling_for_2',
    name: 'Buying for 1, Selling for 2',
    icon: '💵',
    description: 'Earned 50 coins',
    unlocked: stats.coins_earned >= 50,
    progress: stats.coins_earned,
    target: 50
  });
  
  achievements.push({
    id: 'i_got_99_problems',
    name: 'I Got 99 Problems',
    icon: '💵',
    description: 'Earned 99 coins',
    unlocked: stats.coins_earned >= 99,
    progress: stats.coins_earned,
    target: 99
  });
  
  achievements.push({
    id: 'franklins',
    name: "Franklin's",
    icon: '💵',
    description: 'Earned 100 coins',
    unlocked: stats.coins_earned >= 100,
    progress: stats.coins_earned,
    target: 100
  });
  
  achievements.push({
    id: 'fat_stacks',
    name: 'Fat Stacks',
    icon: '💵',
    description: 'Earned 250 coins',
    unlocked: stats.coins_earned >= 250,
    progress: stats.coins_earned,
    target: 250
  });
  
  achievements.push({
    id: 'im_rich_bitch',
    name: "I'm Rich, Bitch!",
    icon: '💵',
    description: 'Earned 500 coins',
    unlocked: stats.coins_earned >= 500,
    progress: stats.coins_earned,
    target: 500
  });
  
  achievements.push({
    id: 'unstoppable_treasurer',
    name: 'Unstoppable Treasurer',
    icon: '💵',
    description: 'Earned 1000 coins',
    unlocked: stats.coins_earned >= 1000,
    progress: stats.coins_earned,
    target: 1000
  });
  
  achievements.push({
    id: 'economic_powerhouse',
    name: 'Economic Powerhouse',
    icon: '💵',
    description: 'Earned 2500 coins',
    unlocked: stats.coins_earned >= 2500,
    progress: stats.coins_earned,
    target: 2500
  });
  
  // === ELO ACHIEVEMENTS ===
  achievements.push({
    id: 'rising_star',
    name: 'Rising Star',
    icon: '⭐',
    description: 'Reached 1250 Elo',
    unlocked: stats.elo_rating >= 1250,
    progress: stats.elo_rating,
    target: 1250
  });
  
  achievements.push({
    id: 'lucky_you',
    name: 'Lucky You',
    icon: '⭐',
    description: 'Reached 1313 Elo',
    unlocked: stats.elo_rating >= 1313,
    progress: stats.elo_rating,
    target: 1313
  });
  
  achievements.push({
    id: 'l33t_haxx0rz',
    name: 'L33t Haxx0rz',
    icon: '⭐',
    description: 'Reached 1337 Elo',
    unlocked: stats.elo_rating >= 1337,
    progress: stats.elo_rating,
    target: 1337
  });
  
  achievements.push({
    id: 'discovered_the_americas',
    name: 'Discovered the Americas',
    icon: '⭐',
    description: 'Reached 1492 Elo',
    unlocked: stats.elo_rating >= 1492,
    progress: stats.elo_rating,
    target: 1492
  });
  
  achievements.push({
    id: 'in_full_bloom',
    name: 'In Full Bloom',
    icon: '⭐',
    description: 'Reached 1500 Elo',
    unlocked: stats.elo_rating >= 1500,
    progress: stats.elo_rating,
    target: 1500
  });
  
  achievements.push({
    id: 'high_society',
    name: 'High Society',
    icon: '⭐',
    description: 'Reached 1750 Elo',
    unlocked: stats.elo_rating >= 1750,
    progress: stats.elo_rating,
    target: 1750
  });
  
  achievements.push({
    id: 'top_of_the_game',
    name: 'Top of the Game',
    icon: '⭐',
    description: 'Reached 2000 Elo',
    unlocked: stats.elo_rating >= 2000,
    progress: stats.elo_rating,
    target: 2000
  });
  
  achievements.push({
    id: 'grandmaster',
    name: 'Grandmaster',
    icon: '⭐',
    description: 'Reached 2500 Elo',
    unlocked: stats.elo_rating >= 2500,
    progress: stats.elo_rating,
    target: 2500
  });
  
  // === SPECIAL ACHIEVEMENTS ===
  
  // Sharpshooter
  const totalChallenges = stats.successful_challenges + stats.failed_challenges;
  const challengeAccuracy = totalChallenges > 0 
    ? stats.successful_challenges / totalChallenges
    : 0;
  const sharpshooterUnlocked = challengeAccuracy >= 0.75 && stats.successful_challenges >= 20;
  achievements.push({
    id: 'sharpshooter',
    name: 'Sharpshooter',
    icon: '🎯',
    description: '75%+ challenge accuracy (20+ challenges)',
    unlocked: sharpshooterUnlocked,
    progress: stats.successful_challenges,
    target: 20,
    accuracy: Math.round(challengeAccuracy * 100)
  });
  
  // The Untouchable
  const avgInfluencesLost = stats.games_played > 0 ? stats.influences_lost / stats.games_played : 0;
  const untouchableUnlocked = stats.games_won >= 5 && avgInfluencesLost < 1.5;
  achievements.push({
    id: 'untouchable',
    name: 'The Untouchable',
    icon: '✨',
    description: 'Win 5+ games while losing <1.5 influences per game',
    unlocked: untouchableUnlocked,
    progress: stats.games_won,
    target: 5,
    avgInfluences: avgInfluencesLost.toFixed(2)
  });
  
  return achievements;
}

// GET /api/profile/:identifier - Get user profile
app.get('/api/profile/:identifier', (req, res) => {
  const { identifier } = req.params;
  
  try {
    // Try to find by username first, then by userId
    let user;
    if (isNaN(identifier)) {
      // It's a username
      user = db.prepare('SELECT * FROM users WHERE username = ?').get(identifier);
    } else {
      // It's a userId
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(parseInt(identifier));
    }
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Get stats
    const stats = db.prepare('SELECT * FROM user_stats WHERE user_id = ?').get(user.id);
    
    if (!stats) {
      return res.status(404).json({ error: 'User stats not found' });
    }
    
    // Calculate derived metrics
    const winRate = stats.games_played > 0 ? (stats.games_won / stats.games_played * 100).toFixed(1) : 0;
    const kdRatio = stats.influences_lost > 0 ? (stats.players_eliminated / stats.influences_lost).toFixed(2) : stats.players_eliminated;
    const challengeAccuracy = (stats.successful_challenges + stats.failed_challenges) > 0
      ? (stats.successful_challenges / (stats.successful_challenges + stats.failed_challenges) * 100).toFixed(1)
      : 0;
    const bluffSuccessRate = (stats.bluffs_succeeded + stats.bluffs_caught) > 0
      ? (stats.bluffs_succeeded / (stats.bluffs_succeeded + stats.bluffs_caught) * 100).toFixed(1)
      : 0;
    
    // Get rank
    const rankData = db.prepare(`
      SELECT COUNT(*) + 1 as rank 
      FROM user_stats 
      WHERE elo_rating > ? AND games_played >= 5
    `).get(stats.elo_rating);
    
    // Get total ranked players
    const totalPlayers = db.prepare('SELECT COUNT(*) as count FROM user_stats WHERE games_played >= 5').get();
    
    // Calculate playstyle
    const playstyle = calculatePlaystyle(stats);
    
    // Calculate achievements
    const achievements = calculateAchievements(stats);
    
    // Get existing unlock dates and record new ones
    try {
      const existingUnlocks = db.prepare(
        'SELECT achievement_id, unlocked_at FROM achievement_unlocks WHERE user_id = ?'
      ).all(user.id);
      const unlockDates = {};
      existingUnlocks.forEach(row => { unlockDates[row.achievement_id] = row.unlocked_at; });
      
      const insertUnlock = db.prepare(
        'INSERT OR IGNORE INTO achievement_unlocks (user_id, achievement_id) VALUES (?, ?)'
      );
      let anyNew = false;
      achievements.forEach(achievement => {
        if (achievement.unlocked) {
          if (!unlockDates[achievement.id]) {
            insertUnlock.run(user.id, achievement.id);
            unlockDates[achievement.id] = new Date().toISOString();
            anyNew = true;
          }
          achievement.unlockedAt = unlockDates[achievement.id];
        }
      });
      if (anyNew) db.saveDatabase();
    } catch (e) {
      console.error('Achievement unlock tracking error (table may need migration):', e.message);
    }
    
    res.json({
      user: {
        id: user.id,
        username: user.username,
        createdAt: user.created_at,
        bio: user.bio || ''
      },
      stats: {
        ...stats,
        win_rate: parseFloat(winRate),
        kd_ratio: parseFloat(kdRatio),
        challenge_accuracy: parseFloat(challengeAccuracy),
        bluff_success_rate: parseFloat(bluffSuccessRate)
      },
      rank: {
        current: rankData.rank,
        total: totalPlayers.count,
        percentile: totalPlayers.count > 0 ? ((1 - (rankData.rank / totalPlayers.count)) * 100).toFixed(1) : 0
      },
      playstyle,
      achievements,
      privacy: (() => {
        try {
          const p = JSON.parse(user.privacy_settings || '{}');
          return {
            showIndividualStats: p.showIndividualStats === true,
            showWinRate: p.showWinRate === true,
            showAchievements: p.showAchievements === true,
            showMatchHistory: p.showMatchHistory === true
          };
        } catch { return {}; }
      })()
    });
    
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/profile/:identifier/matches - Get match history
app.get('/api/profile/:identifier/matches', (req, res) => {
  const { identifier } = req.params;
  const limit = parseInt(req.query.limit) || 20;
  
  try {
    // Find user
    let user;
    if (isNaN(identifier)) {
      user = db.prepare('SELECT * FROM users WHERE username = ?').get(identifier);
    } else {
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(parseInt(identifier));
    }
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Get match history
    const matches = db.prepare(`
      SELECT * FROM game_history 
      WHERE player_data LIKE ? 
      ORDER BY ended_at DESC 
      LIMIT ?
    `).all(`%"userId":${user.id}%`, limit);
    
    // Parse and format matches
    const formattedMatches = matches.map(match => {
      const playerData = JSON.parse(match.player_data);
      const myData = playerData.find(p => p.userId === user.id);
      const winner = playerData.find(p => p.userId === match.winner_id);
      
      // Determine placement
      const sortedPlayers = playerData.sort((a, b) => {
        if (a.influencesRemaining !== b.influencesRemaining) {
          return b.influencesRemaining - a.influencesRemaining;
        }
        return b.finalCoins - a.finalCoins;
      });
      const placement = sortedPlayers.findIndex(p => p.userId === user.id) + 1;
      
      return {
        gameId: match.id,
        roomCode: match.room_code,
        endedAt: match.ended_at,
        placement,
        totalPlayers: playerData.length,
        isWinner: match.winner_id === user.id,
        finalCoins: myData?.finalCoins || 0,
        influencesRemaining: myData?.influencesRemaining || 0,
        eloChange: myData?.eloChange || null,
        players: playerData.map(p => ({
          username: p.username || p.name,
          isMe: p.userId === user.id,
          isWinner: p.userId === match.winner_id,
          finalCoins: p.finalCoins,
          influencesRemaining: p.influencesRemaining
        })),
        stats: myData?.gameStats || {}
      };
    });
    
    res.json({ matches: formattedMatches });
    
  } catch (error) {
    console.error('Error fetching match history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/leaderboards/:type - Get leaderboard
app.get('/api/leaderboards/:type', (req, res) => {
  const { type } = req.params;
  const limit = parseInt(req.query.limit) || 100;
  const minGames = parseInt(req.query.minGames) || 5;
  const timeFilter = req.query.time || 'all'; // all, month, week
  
  try {
    let query;
    let orderBy;
    
    switch (type) {
      case 'elo':
        query = `
          SELECT u.id, u.username, s.* 
          FROM user_stats s
          JOIN users u ON s.user_id = u.id
          WHERE s.games_played >= ?
          ORDER BY s.elo_rating DESC, s.games_won DESC
          LIMIT ?
        `;
        break;
        
      case 'winrate':
        query = `
          SELECT u.id, u.username, s.*,
                 (CAST(s.games_won AS FLOAT) / s.games_played * 100) as win_rate
          FROM user_stats s
          JOIN users u ON s.user_id = u.id
          WHERE s.games_played >= ?
          ORDER BY win_rate DESC, s.games_won DESC
          LIMIT ?
        `;
        break;
        
      case 'kd':
        query = `
          SELECT u.id, u.username, s.*,
                 (CAST(s.players_eliminated AS FLOAT) / NULLIF(s.influences_lost, 0)) as kd_ratio
          FROM user_stats s
          JOIN users u ON s.user_id = u.id
          WHERE s.games_played >= ? AND s.influences_lost > 0
          ORDER BY kd_ratio DESC, s.players_eliminated DESC
          LIMIT ?
        `;
        break;
        
      case 'wins':
        query = `
          SELECT u.id, u.username, s.* 
          FROM user_stats s
          JOIN users u ON s.user_id = u.id
          WHERE s.games_played >= ?
          ORDER BY s.games_won DESC, s.elo_rating DESC
          LIMIT ?
        `;
        break;
        
      case 'games':
        query = `
          SELECT u.id, u.username, s.* 
          FROM user_stats s
          JOIN users u ON s.user_id = u.id
          ORDER BY s.games_played DESC, s.elo_rating DESC
          LIMIT ?
        `;
        break;
        
      case 'bluffer':
        query = `
          SELECT u.id, u.username, s.* 
          FROM user_stats s
          JOIN users u ON s.user_id = u.id
          WHERE s.games_played >= ?
          ORDER BY s.bluffs_succeeded DESC, s.elo_rating DESC
          LIMIT ?
        `;
        break;
        
      case 'tax':
        query = `
          SELECT u.id, u.username, s.* 
          FROM user_stats s
          JOIN users u ON s.user_id = u.id
          WHERE s.games_played >= ?
          ORDER BY s.tax_succeeded DESC, s.elo_rating DESC
          LIMIT ?
        `;
        break;
        
      case 'assassin':
        query = `
          SELECT u.id, u.username, s.* 
          FROM user_stats s
          JOIN users u ON s.user_id = u.id
          WHERE s.games_played >= ?
          ORDER BY s.assassinations_succeeded DESC, s.elo_rating DESC
          LIMIT ?
        `;
        break;
        
      case 'finisher':
        query = `
          SELECT u.id, u.username, s.* 
          FROM user_stats s
          JOIN users u ON s.user_id = u.id
          WHERE s.games_played >= ?
          ORDER BY s.players_eliminated DESC, s.elo_rating DESC
          LIMIT ?
        `;
        break;
        
      case 'economist':
        query = `
          SELECT u.id, u.username, s.* 
          FROM user_stats s
          JOIN users u ON s.user_id = u.id
          WHERE s.games_played >= ?
          ORDER BY s.coins_earned DESC, s.elo_rating DESC
          LIMIT ?
        `;
        break;
        
      default:
        return res.status(400).json({ error: 'Invalid leaderboard type' });
    }
    
    const results = type === 'games'
      ? db.prepare(query).all(limit)
      : db.prepare(query).all(minGames, limit);
    
    // Calculate derived metrics for each player
    const leaderboard = results.map((player, index) => {
      const winRate = player.games_played > 0 ? (player.games_won / player.games_played * 100).toFixed(1) : 0;
      const kdRatio = player.influences_lost > 0 ? (player.players_eliminated / player.influences_lost).toFixed(2) : player.players_eliminated;
      
      return {
        rank: index + 1,
        userId: player.id,
        username: player.username,
        primaryStat: type === 'elo' ? player.elo_rating :
                     type === 'winrate' ? parseFloat(winRate) :
                     type === 'kd' ? parseFloat(kdRatio) :
                     type === 'wins' ? player.games_won :
                     type === 'games' ? player.games_played :
                     type === 'bluffer' ? player.bluffs_succeeded :
                     type === 'tax' ? player.tax_succeeded :
                     type === 'assassin' ? player.assassinations_succeeded :
                     type === 'finisher' ? player.players_eliminated :
                     type === 'economist' ? player.coins_earned : 0,
        secondaryStats: {
          gamesPlayed: player.games_played,
          gamesWon: player.games_won,
          winRate: parseFloat(winRate),
          elo: player.elo_rating
        }
      };
    });
    
    res.json({ 
      type,
      leaderboard,
      minGames,
      timeFilter
    });
    
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/leaderboards/me/:type - Get my rank in leaderboard
app.get('/api/leaderboards/me/:type', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { type } = req.params;
    const minGames = parseInt(req.query.minGames) || 5;
    
    // Get user's stats (JWT uses 'id' not 'userId')
    const userStats = db.prepare('SELECT * FROM user_stats WHERE user_id = ?').get(decoded.id);
    if (!userStats) {
      return res.status(404).json({ error: 'Stats not found' });
    }
    
    // Calculate rank based on type
    let rankQuery;
    let userValue;
    
    switch (type) {
      case 'elo':
        rankQuery = `
          SELECT COUNT(*) + 1 as rank 
          FROM user_stats 
          WHERE elo_rating > ? AND games_played >= ?
        `;
        userValue = userStats.elo_rating;
        break;
        
      case 'winrate':
        const userWinRate = userStats.games_played > 0 ? (userStats.games_won / userStats.games_played) : 0;
        rankQuery = `
          SELECT COUNT(*) + 1 as rank 
          FROM user_stats 
          WHERE (CAST(games_won AS FLOAT) / games_played) > ? AND games_played >= ?
        `;
        userValue = userWinRate;
        break;
        
      case 'kd':
        const userKD = userStats.influences_lost > 0 ? (userStats.players_eliminated / userStats.influences_lost) : userStats.players_eliminated;
        rankQuery = `
          SELECT COUNT(*) + 1 as rank 
          FROM user_stats 
          WHERE (CAST(players_eliminated AS FLOAT) / NULLIF(influences_lost, 0)) > ? AND games_played >= ?
        `;
        userValue = userKD;
        break;
        
      case 'wins':
        rankQuery = `
          SELECT COUNT(*) + 1 as rank 
          FROM user_stats 
          WHERE games_won > ? AND games_played >= ?
        `;
        userValue = userStats.games_won;
        break;
        
      case 'games':
        rankQuery = `
          SELECT COUNT(*) + 1 as rank 
          FROM user_stats 
          WHERE games_played > ?
        `;
        userValue = userStats.games_played;
        break;
        
      default:
        return res.status(400).json({ error: 'Invalid leaderboard type' });
    }
    
    // Execute rank query with appropriate parameters
    const rankData = type === 'games' 
      ? db.prepare(rankQuery).get(userValue)
      : db.prepare(rankQuery).get(userValue, minGames);
    
    const totalPlayers = type === 'games'
      ? db.prepare('SELECT COUNT(*) as count FROM user_stats').get()
      : db.prepare('SELECT COUNT(*) as count FROM user_stats WHERE games_played >= ?').get(minGames);
    
    res.json({
      rank: rankData.rank,
      totalPlayers: totalPlayers.count,
      value: userValue
    });
    
  } catch (error) {
    console.error('Error fetching my rank:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Lobby system tracking
const lobbySockets = new Map(); // socketId -> { username, socketId, isAuthenticated, userId, inGame }
const pendingLobbyRemovals = new Map(); // username -> timeout
const LOBBY_REMOVAL_DELAY = 3000; // 3 seconds grace period for page navigation

function broadcastRoomList() {
  const roomList = Array.from(rooms.entries())
    .map(([code, room]) => {
      // Count only players who haven't left
      const activePlayers = room.players.filter(p => !p.hasLeft);
      const activeSpectators = room.spectators.filter(s => !s.hasLeft);
      
      return {
        code: code,
        name: room.name,
        state: room.state,
        playerCount: activePlayers.length,
        spectatorCount: activeSpectators.length,
        useInquisitor: room.useInquisitor,
        allowSpectators: room.allowSpectators,
        chatMode: room.chatMode,
        hasPassword: !!room.password,
        ranked: room.ranked,
        anonymousMode: room.anonymousMode,
        _hasActivePlayers: activePlayers.length > 0 || activeSpectators.length > 0
      };
    })
    .filter(room => room._hasActivePlayers); // Only show rooms with active players/spectators
  
  // Remove the internal flag before sending
  roomList.forEach(room => delete room._hasActivePlayers);
  
  lobbySockets.forEach((userData, socketId) => {
    io.to(socketId).emit('roomListUpdate', { rooms: roomList });
  });
}

function broadcastOnlineUsers() {
  // Get all users
  const allUsers = Array.from(lobbySockets.values()).map(user => ({
    username: user.username,
    isAuthenticated: user.isAuthenticated || false,
    inGame: user.inGame || false,
    userId: user.userId
  }));
  
  // Deduplicate users
  const seenAuthUsers = new Set();
  const seenGuestUsers = new Set();
  const uniqueUsers = [];
  
  allUsers.forEach(user => {
    if (user.isAuthenticated && user.userId) {
      // For authenticated users, dedupe by userId
      if (!seenAuthUsers.has(user.userId)) {
        seenAuthUsers.add(user.userId);
        uniqueUsers.push({
          username: user.username,
          isAuthenticated: user.isAuthenticated,
          inGame: user.inGame
        });
      }
    } else {
      // For guests, dedupe by username
      const guestKey = `guest_${user.username}`;
      if (!seenGuestUsers.has(guestKey)) {
        seenGuestUsers.add(guestKey);
        uniqueUsers.push({
          username: user.username,
          isAuthenticated: user.isAuthenticated,
          inGame: user.inGame
        });
      }
    }
  });
  
  // Broadcast to all lobby users
  lobbySockets.forEach((userData, socketId) => {
    io.to(socketId).emit('onlineUsersUpdate', { users: uniqueUsers });
  });
}

// Socket.IO event handlers
io.on('connection', (socket) => {
  
  // Store user info from auth token (if provided)
  let authenticatedUser = null;
  const token = socket.handshake.auth.token;
  
  if (token) {
    const verification = auth.verifyToken(token);
    if (verification.success) {
      authenticatedUser = verification.user;
    }
  }

  socket.on('createRoom', (data, callback) => {
    const roomCode = generateRoomCode();
    
    // Determine player name first (needed for default room name)
    const playerName = authenticatedUser ? authenticatedUser.username : (data.playerName || 'Player');
    
    // Generate default room name if none provided
    const roomName = data.gameName || `${playerName}'s Room`;
    
    const room = createRoom(roomCode, { 
      name: roomName,
      useInquisitor: data.useInquisitor || false,
      allowSpectators: data.allowSpectators !== false,
      chatMode: data.chatMode || 'separate',
      password: data.password || null,
      ranked: data.ranked !== false,
      anonymousMode: data.anonymousMode || false
    });
    
    // Fetch stats if authenticated
    let stats = null;
    if (authenticatedUser && authenticatedUser.stats) {
      stats = authenticatedUser.stats;
    }
    
    const player = {
      id: data.persistentPlayerId || socket.id,
      persistentId: data.persistentPlayerId || socket.id,
      socketId: socket.id,
      name: playerName,
      userId: authenticatedUser ? authenticatedUser.id : null,
      username: authenticatedUser ? authenticatedUser.username : null,
      isGuest: !authenticatedUser,
      stats: stats,
      coins: 2,
      influences: [],
      alive: true,
      disconnected: false
    };

    room.players.push(player);
    rooms.set(roomCode, room);
    socket.join(roomCode);
    
    // Mark user as in game in lobby
    const lobbyUser = lobbySockets.get(socket.id);
    if (lobbyUser) {
      lobbyUser.inGame = true;
      broadcastOnlineUsers();
    }
    
    // Broadcast room list update
    broadcastRoomList();
    
    callback({ success: true, roomCode });
    emitToRoom(roomCode, 'gameState');
  });

  socket.on('previewRoom', (data, callback) => {
    const { roomCode } = data;
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    // Send room info without joining
    callback({ 
      success: true,
      roomData: {
        code: room.code,
        state: room.state,
        useInquisitor: room.useInquisitor,
        allowSpectators: room.allowSpectators,
        chatMode: room.chatMode,
        anonymousMode: room.anonymousMode,
        players: room.players.map(p => ({
          id: p.id,
          name: p.name,
          username: p.username || null,
          isGuest: p.isGuest === true,
          userId: p.userId || null,
          stats: p.stats || null,
          isMe: false
        })),
        spectators: room.spectators.map(s => ({
          id: s.id,
          name: s.name,
          isMe: false
        }))
      }
    });
  });

  socket.on('playAgain', (data, callback) => {
    const { currentRoomCode, useInquisitor, allowSpectators, chatMode, ranked, hasPassword, anonymousMode } = data;
    
    const oldRoom = rooms.get(currentRoomCode);
    if (!oldRoom) {
      callback({ success: false, error: 'Original room not found' });
      return;
    }
    
    // Check if a rematch room already exists for this game
    let rematchRoomCode = oldRoom.rematchRoomCode;
    let rematchRoom = rematchRoomCode ? rooms.get(rematchRoomCode) : null;
    
    // If rematch room doesn't exist or has been deleted, create a new one
    if (!rematchRoom) {
      rematchRoomCode = generateRoomCode();
      
      // Determine room name
      const oldRoomName = oldRoom.name || 'Game';
      
      // Create rematch room with same settings (no password)
      rematchRoom = createRoom(rematchRoomCode, {
        name: `${oldRoomName} - Rematch`,
        useInquisitor: useInquisitor,
        allowSpectators: allowSpectators,
        chatMode: chatMode,
        password: null, // Don't copy password
        ranked: ranked,
        anonymousMode: anonymousMode
      });
      
      rooms.set(rematchRoomCode, rematchRoom);
      
      // Link the old room to the new rematch room
      oldRoom.rematchRoomCode = rematchRoomCode;
      
      // Broadcast the new room to all lobby users
      broadcastRoomList();
    }
    
    // Remove player from old room
    const playerIndex = oldRoom.players.findIndex(p => p.socketId === socket.id);
    const spectatorIndex = oldRoom.spectators.findIndex(s => s.socketId === socket.id);
    
    if (playerIndex !== -1) {
      oldRoom.players[playerIndex].hasLeft = true;
      oldRoom.players.splice(playerIndex, 1);
    } else if (spectatorIndex !== -1) {
      oldRoom.spectators[spectatorIndex].hasLeft = true;
      oldRoom.spectators.splice(spectatorIndex, 1);
    }
    
    // Clean up old room if empty
    const activePlayers = oldRoom.players.filter(p => !p.hasLeft);
    const activeSpectators = oldRoom.spectators.filter(s => !s.hasLeft);
    if (activePlayers.length === 0 && activeSpectators.length === 0) {
      rooms.delete(currentRoomCode);
    } else {
      emitToRoom(currentRoomCode, 'gameState');
    }
    
    // Mark user as not in game in lobby
    const lobbyUser = lobbySockets.get(socket.id);
    if (lobbyUser) {
      lobbyUser.inGame = false;
      broadcastOnlineUsers();
    }
    
    callback({
      success: true,
      newRoomCode: rematchRoomCode
    });
  });

  socket.on('joinRoom', (data, callback) => {
    const { roomCode, playerName, asSpectator, persistentPlayerId, password } = data;
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    // Check password if room is password protected
    if (room.password && room.password !== password) {
      callback({ success: false, error: 'Incorrect password' });
      return;
    }

    // Check if this persistent ID is already connected in this room
    if (persistentPlayerId) {
      const existingPlayer = room.players.find(p => p.persistentId === persistentPlayerId && !p.hasLeft);
      if (existingPlayer && existingPlayer.socketId !== socket.id) {
        callback({ success: false, error: 'You are already connected in another tab/window' });
        return;
      }
    }

    if (room.state !== 'lobby') {
      // During active game, force spectator mode
      if (!room.allowSpectators) {
        callback({ success: false, error: 'Game in progress and spectators not allowed' });
        return;
      }

      const spectator = {
        id: socket.id,
        socketId: socket.id,
        name: authenticatedUser ? authenticatedUser.username : (playerName || `Spectator ${room.spectators.length + 1}`)
      };

      room.spectators.push(spectator);
      socket.join(roomCode);
      
      callback({ success: true, joinedAs: 'spectator' });
      emitToRoom(roomCode, 'gameState');
      return;
    }

    // In lobby - check if joining as spectator or player
    if (asSpectator || room.players.length >= 6) {
      if (!room.allowSpectators) {
        callback({ success: false, error: 'Spectators not allowed in this room' });
        return;
      }

      const spectator = {
        id: socket.id,
        socketId: socket.id,
        name: authenticatedUser ? authenticatedUser.username : (playerName || `Spectator ${room.spectators.length + 1}`)
      };

      room.spectators.push(spectator);
      socket.join(roomCode);
      
      callback({ success: true, joinedAs: 'spectator' });
      emitToRoom(roomCode, 'gameState');
      return;
    }

    // Join as player
    // Fetch stats if authenticated
    let stats = null;
    if (authenticatedUser && authenticatedUser.stats) {
      stats = authenticatedUser.stats;
    }
    
    const player = {
      id: persistentPlayerId || socket.id,
      persistentId: persistentPlayerId || socket.id,
      socketId: socket.id,
      name: authenticatedUser ? authenticatedUser.username : (playerName || `Player ${room.players.length + 1}`),
      userId: authenticatedUser ? authenticatedUser.id : null,
      username: authenticatedUser ? authenticatedUser.username : null,
      isGuest: !authenticatedUser,
      stats: stats,
      coins: 2,
      influences: [],
      alive: true,
      disconnected: false
    };

    room.players.push(player);
    socket.join(roomCode);
    
    // Mark user as in game in lobby
    const lobbyUser = lobbySockets.get(socket.id);
    if (lobbyUser) {
      lobbyUser.inGame = true;
      broadcastOnlineUsers();
    }
    
    // Broadcast room list update
    broadcastRoomList();
    
    callback({ success: true, joinedAs: 'player' });
    emitToRoom(roomCode, 'gameState');
  });

  socket.on('attemptReconnect', (data, callback) => {
    const { roomCode, persistentPlayerId } = data;
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    // Find player by persistent ID
    const player = room.players.find(p => p.persistentId === persistentPlayerId);
    
    if (!player) {
      callback({ success: false, error: 'Player not found in this room' });
      return;
    }

    if (player.hasLeft) {
      callback({ success: false, error: 'You have left this game' });
      return;
    }

    // Cancel disconnection timer if exists
    const timerKey = `${roomCode}-${persistentPlayerId}`;
    if (disconnectionTimers.has(timerKey)) {
      clearTimeout(disconnectionTimers.get(timerKey));
      disconnectionTimers.delete(timerKey);
    }

    // Update socket ID and mark as reconnected
    player.socketId = socket.id;
    player.disconnected = false;
    socket.join(roomCode);

    addLogToRoom(room, `âœ… ${player.name} reconnected!`, 'info');
    
    // Check if there's an action paused waiting for this player
    if (room.actionInProgress && room.actionInProgress.pausedForDisconnection) {
      if (room.actionInProgress.phase === 'waiting') {
        const targetId = room.actionInProgress.targetId;
        if (targetId === player.id) {
          // Check if all disconnected responders are now connected
          const stillDisconnected = room.players.some(p => 
            p.alive && 
            p.id !== room.actionInProgress.playerId && 
            p.disconnected &&
            (!room.actionInProgress.targetId || p.id === room.actionInProgress.targetId)
          );
          
          if (!stillDisconnected) {
            // Resume the action - start countdown
            room.actionInProgress.pausedForDisconnection = false;
            addLogToRoom(room, `Action resumed - waiting for responses...`, 'info');
            
            // Start the timeout now
            room.actionInProgress.responseTimeout = setTimeout(() => {
              if (room.actionInProgress && room.actionInProgress.phase === 'waiting') {
                if (room.actionInProgress.action === 'foreignAid') {
                  addLogToRoom(room, `No one blocked Foreign Aid`, 'info');
                }
                resolveAction(room);
                emitToRoom(room.code, 'gameState');
              }
            }, 12000); // 12 seconds
          }
        }
      } else if (room.actionInProgress.phase === 'block') {
        // Check if all disconnected challengers are now connected
        const blockerId = room.actionInProgress.blockerId;
        const stillDisconnected = room.players.some(p => 
          p.alive && 
          p.id !== blockerId && 
          p.disconnected
        );
        
        if (!stillDisconnected) {
          // Resume the block challenge phase
          room.actionInProgress.pausedForDisconnection = false;
          addLogToRoom(room, `Block challenge resumed - waiting for responses...`, 'info');
          
          const action = room.actionInProgress;
          const blockCard = room.actionInProgress.blockCard;
          
          room.actionInProgress.responseTimeout = setTimeout(() => {
            if (room.actionInProgress && room.actionInProgress.phase === 'block') {
              if (action.action === 'foreignAid') {
                addLogToRoom(room, `No one challenges the block. Foreign Aid is blocked!`, 'success', blockCard);
              } else {
                addLogToRoom(room, `No one challenges the block. The action is blocked!`, 'success', blockCard);
              }
              room.actionInProgress = null;
              nextTurn(room);
              emitToRoom(room.code, 'gameState');
            }
          }, 12000); // 12 seconds
        }
      }
    }
    
    callback({ success: true, gameState: room.state });
    emitToRoom(roomCode, 'gameState');
  });

  socket.on('switchToPlayer', (data, callback) => {
    const { roomCode, persistentPlayerId } = data;
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    const result = switchToPlayer(room, socket.id, data.name, persistentPlayerId, authenticatedUser);
    callback(result);
    
    if (result.success) {
      emitToRoom(roomCode, 'gameState');
    }
  });

  socket.on('switchToSpectator', (data, callback) => {
    const { roomCode } = data;
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    const result = switchToSpectator(room, socket.id);
    callback(result);
    
    if (result.success) {
      emitToRoom(roomCode, 'gameState');
    }
  });

  socket.on('startGame', (data, callback) => {
    const { roomCode } = data;
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    const result = startGame(room);
    callback(result);
    
    if (result.success) {
      emitToRoom(roomCode, 'gameState');
      // Broadcast room list update (state changed from lobby to playing)
      broadcastRoomList();
    }
  });

  socket.on('performAction', (data, callback) => {
    const { roomCode, action, targetId } = data;
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    const result = performAction(room, socket.id, action, targetId);
    callback(result);
    
    if (result.success) {
      emitToRoom(roomCode, 'gameState');
    }
  });

  socket.on('respondToAction', (data, callback) => {
    const { roomCode, response } = data;
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    const result = respondToAction(room, socket.id, response);
    callback(result);
    
    if (result.success) {
      emitToRoom(roomCode, 'gameState');
    }
  });

  socket.on('challengeBlock', (data, callback) => {
    const { roomCode } = data;
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    const result = challengeBlock(room, socket.id);
    callback(result);
    
    if (result.success) {
      emitToRoom(roomCode, 'gameState');
    }
  });

  socket.on('completeExchange', (data, callback) => {
    const { roomCode, keepIndices } = data;
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    const player = getPlayerBySocketId(room, socket.id);
    if (!player) {
      callback({ success: false, error: 'Player not found' });
      return;
    }

    const result = completeExchange(room, player.id, keepIndices);
    callback(result);
    
    if (result.success) {
      emitToRoom(roomCode, 'gameState');
    }
  });

  socket.on('showCardToExaminer', (data, callback) => {
    const { roomCode, cardIndex } = data;
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    const player = getPlayerBySocketId(room, socket.id);
    if (!player) {
      callback({ success: false, error: 'Player not found' });
      return;
    }

    const result = showCardToExaminer(room, player.id, cardIndex);
    callback(result);
    
    if (result.success) {
      emitToRoom(roomCode, 'gameState');
    }
  });

  socket.on('completeExamine', (data, callback) => {
    const { roomCode, forceExchange } = data;
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    const player = getPlayerBySocketId(room, socket.id);
    if (!player) {
      callback({ success: false, error: 'Player not found' });
      return;
    }

    const result = completeExamine(room, player.id, forceExchange);
    callback(result);
    
    if (result.success) {
      emitToRoom(roomCode, 'gameState');
    }
  });

  socket.on('revealInfluence', (data, callback) => {
    const { roomCode, cardIndex } = data;
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    const player = getPlayerBySocketId(room, socket.id);
    if (!player) {
      callback({ success: false, error: 'Player not found' });
      return;
    }

    const result = revealInfluence(room, player.id, cardIndex);
    callback(result);
    
    if (result.success) {
      emitToRoom(roomCode, 'gameState');
    }
  });

  socket.on('leaveRoom', (data) => {
    const { roomCode } = data;
    const room = rooms.get(roomCode);
    
    if (!room) return;
    
    const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
    const spectatorIndex = room.spectators.findIndex(s => s.socketId === socket.id);
    
    if (playerIndex !== -1) {
      const player = room.players[playerIndex];
      
      // Mark player as having left so they stop receiving updates
      player.hasLeft = true;
      
      // Remove socket from the room
      socket.leave(roomCode);
      
      if (room.state === 'playing') {
        // Player forfeits - reveal all influences and eliminate
        const revealedCards = [];
        player.influences.forEach(inf => {
          if (!inf.revealed) {
            inf.revealed = true;
            revealedCards.push(inf.card);
          }
        });
        
        // Track elimination before marking as not alive
        if (player.alive) {
          const alivePlayers = room.players.filter(p => p.alive && p.id !== player.id).length;
          const placement = alivePlayers + 1;
          const eliminationEntry = {
            playerId: player.id,
            playerName: player.name,
            userId: player.userId,
            username: player.username,
            coinsEarned: player.gameStats?.coinsEarned || 0,
            eliminations: player.gameStats?.playersEliminated || 0,
            placement: placement
          };
          room.eliminationOrder.push(eliminationEntry);
        }
        
        player.alive = false;
        player.disconnected = true; // Mark as disconnected so they stay visible
        player.mustRevealInfluence = false;
        player.mustChooseExchange = false;
        player.mustChooseExamine = false;
        player.mustShowCardToExaminer = false;
        player.influencesToLose = 0;
        
        // Log the forfeit and reveal cards
        addLogToRoom(room, `${player.name} left the game and forfeits!`, 'info');
        if (revealedCards.length > 0) {
          const cardList = revealedCards.join(' and ');
          addLogToRoom(room, `${player.name}'s cards are revealed: ${cardList}`, 'info');
        }
        
        // Check win condition
        checkWinCondition(room);
        
        // If it was their turn, advance to next player
        if (room.currentPlayerIndex === playerIndex) {
          room.actionInProgress = null;
          nextTurn(room);
        }
        
        // Don't remove from array - keep them visible with revealed cards
        // Emit to other players (not this one since hasLeft = true)
        emitToRoom(roomCode, 'gameState');
        
        // Clean up room if no active players/spectators left
        const activePlayers = room.players.filter(p => !p.hasLeft);
        const activeSpectators = room.spectators.filter(s => !s.hasLeft);
        if (activePlayers.length === 0 && activeSpectators.length === 0) {
          rooms.delete(roomCode);
          broadcastRoomList();
        }
      } else {
        // In lobby, remove them completely
        room.players.splice(playerIndex, 1);
        
        // Check if there are any active players or spectators left
        const activePlayers = room.players.filter(p => !p.hasLeft);
        const activeSpectators = room.spectators.filter(s => !s.hasLeft);
        if (activePlayers.length === 0 && activeSpectators.length === 0) {
          rooms.delete(roomCode);
        } else {
          emitToRoom(roomCode, 'gameState');
        }
      }
    } else if (spectatorIndex !== -1) {
      const spectator = room.spectators[spectatorIndex];
      spectator.hasLeft = true;
      socket.leave(roomCode);
      
      room.spectators.splice(spectatorIndex, 1);
      
      // Check if there are any active players or spectators left
      const activePlayers = room.players.filter(p => !p.hasLeft);
      const activeSpectators = room.spectators.filter(s => !s.hasLeft);
      if (activePlayers.length === 0 && activeSpectators.length === 0) {
        rooms.delete(roomCode);
      } else {
        emitToRoom(roomCode, 'gameState');
      }
    }
    
    // Mark user as not in game in lobby
    const lobbyUser = lobbySockets.get(socket.id);
    if (lobbyUser) {
      lobbyUser.inGame = false;
      broadcastOnlineUsers();
    }
    
    // Broadcast room list update
    broadcastRoomList();
  });

  // Lobby events
  socket.on('joinLobby', (data) => {
    // For authenticated users, always use their actual username from the token
    // For guests, use client-supplied username or generate one
    let username;
    if (authenticatedUser) {
      username = authenticatedUser.username;
    } else {
      username = data.username || `Guest_${Math.random().toString(36).substr(2, 6)}`;
    }
    
    // Cancel any pending removal for this user
    if (pendingLobbyRemovals.has(username)) {
      clearTimeout(pendingLobbyRemovals.get(username));
      pendingLobbyRemovals.delete(username);
    }
    
    // Remove any existing socket connections for this user (handles refreshes)
    // For authenticated users, check by userId; for guests, check by username
    const existingSocketsToRemove = [];
    lobbySockets.forEach((userData, socketId) => {
      if (socketId === socket.id) {
        // Skip current socket
        return;
      }
      
      // Match by userId for authenticated users, or by username for guests
      if (authenticatedUser && userData.userId === authenticatedUser.id) {
        existingSocketsToRemove.push(socketId);
      } else if (!authenticatedUser && userData.username === username && !userData.userId) {
        existingSocketsToRemove.push(socketId);
      }
    });
    
    // Remove old connections
    existingSocketsToRemove.forEach(socketId => {
      lobbySockets.delete(socketId);
    });
    
    // Add new connection
    lobbySockets.set(socket.id, {
      username: username,
      socketId: socket.id,
      isAuthenticated: !!authenticatedUser,
      userId: authenticatedUser ? authenticatedUser.id : null,
      inGame: false
    });
    
    // Send initial room list to this user
    broadcastRoomList();
    
    // Broadcast updated online users
    broadcastOnlineUsers();
  });

  socket.on('lobbyChatMessage', (data) => {
    const userData = lobbySockets.get(socket.id);
    if (!userData) return;
    
    const message = data.message.trim();
    if (!message || message.length > 200) return;
    
    // Broadcast to all lobby users
    lobbySockets.forEach((otherUserData, socketId) => {
      io.to(socketId).emit('lobbyChatMessage', {
        username: userData.username,
        message: message,
        isAuthenticated: userData.isAuthenticated,
        timestamp: Date.now()
      });
    });
  });

  socket.on('disconnect', () => {
    
    // Handle player/spectator disconnection
    rooms.forEach((room, roomCode) => {
      const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
      const spectatorIndex = room.spectators.findIndex(s => s.socketId === socket.id);
      
      if (playerIndex !== -1) {
        const player = room.players[playerIndex];
        
        if (room.state === 'playing' && !player.hasLeft) {
          // Start grace period for reconnection
          player.disconnected = true;
          addLogToRoom(room, `âš ï¸ ${player.name} disconnected. Waiting 30 seconds to reconnect...`, 'info');
          
          const timerKey = `${roomCode}-${player.persistentId}`;
          const forfeitTimer = setTimeout(() => {
            // Grace period expired - forfeit
            
            // Check if player is still disconnected
            const currentPlayer = room.players[playerIndex];
            if (currentPlayer && currentPlayer.disconnected) {
              currentPlayer.hasLeft = true;
              
              // Forfeit - reveal all influences and eliminate
              const revealedCards = [];
              currentPlayer.influences.forEach(inf => {
                if (!inf.revealed) {
                  inf.revealed = true;
                  revealedCards.push(inf.card);
                }
              });
              
              // Track elimination before marking as not alive
              if (currentPlayer.alive) {
                const alivePlayers = room.players.filter(p => p.alive && p.id !== currentPlayer.id).length;
                const placement = alivePlayers + 1;
                const eliminationEntry = {
                  playerId: currentPlayer.id,
                  playerName: currentPlayer.name,
                  userId: currentPlayer.userId,
                  username: currentPlayer.username,
                  coinsEarned: currentPlayer.gameStats?.coinsEarned || 0,
                  eliminations: currentPlayer.gameStats?.playersEliminated || 0,
                  placement: placement
                };
                room.eliminationOrder.push(eliminationEntry);
              }
              
              currentPlayer.alive = false;
              currentPlayer.mustRevealInfluence = false;
              currentPlayer.mustChooseExchange = false;
              currentPlayer.mustChooseExamine = false;
              currentPlayer.mustShowCardToExaminer = false;
              currentPlayer.influencesToLose = 0;
              
              addLogToRoom(room, `${currentPlayer.name} failed to reconnect and forfeits!`, 'info');
              if (revealedCards.length > 0) {
                const cardList = revealedCards.join(' and ');
                addLogToRoom(room, `${currentPlayer.name}'s cards are revealed: ${cardList}`, 'info');
              }
              
              // Check win condition
              checkWinCondition(room);
              
              // If it was their turn, advance to next player
              if (room.currentPlayerIndex === playerIndex) {
                room.actionInProgress = null;
                nextTurn(room);
              }
              
              emitToRoom(roomCode, 'gameState');
              
              // Clean up room if no active players/spectators left
              const activePlayers = room.players.filter(p => !p.hasLeft);
              const activeSpectators = room.spectators.filter(s => !s.hasLeft);
              if (activePlayers.length === 0 && activeSpectators.length === 0) {
                rooms.delete(roomCode);
                broadcastRoomList();
              }
            }
            
            disconnectionTimers.delete(timerKey);
          }, DISCONNECTION_GRACE_PERIOD);
          
          disconnectionTimers.set(timerKey, forfeitTimer);
          emitToRoom(roomCode, 'gameState');
        } else if (room.state === 'playing' && player.hasLeft) {
          // Player already left during active game - don't remove from array
          // They should stay visible with revealed cards
        } else {
          // In lobby, just remove them
          player.hasLeft = true;
          room.players.splice(playerIndex, 1);
          
          // Check if there are any active players or spectators left
          const activePlayers = room.players.filter(p => !p.hasLeft);
          const activeSpectators = room.spectators.filter(s => !s.hasLeft);
          if (activePlayers.length === 0 && activeSpectators.length === 0) {
            rooms.delete(roomCode);
          } else {
            emitToRoom(roomCode, 'gameState');
          }
        }
      } else if (spectatorIndex !== -1) {
        const spectator = room.spectators[spectatorIndex];
        spectator.hasLeft = true;
        
        room.spectators.splice(spectatorIndex, 1);
        
        // Check if there are any active players or spectators left
        const activePlayers = room.players.filter(p => !p.hasLeft);
        const activeSpectators = room.spectators.filter(s => !s.hasLeft);
        if (activePlayers.length === 0 && activeSpectators.length === 0) {
          rooms.delete(roomCode);
        } else {
          emitToRoom(roomCode, 'gameState');
        }
      }
    });
    
    // Schedule delayed removal from lobby sockets (grace period for page navigation)
    const userData = lobbySockets.get(socket.id);
    if (userData) {
      const username = userData.username;
      const disconnectedSocketId = socket.id;
      
      // Cancel any existing pending removal for this user
      if (pendingLobbyRemovals.has(username)) {
        clearTimeout(pendingLobbyRemovals.get(username));
      }
      
      // Schedule removal after grace period
      const removalTimeout = setTimeout(() => {
        // Check if this specific socket is still in lobbySockets (not replaced by reconnect)
        const currentUserData = lobbySockets.get(disconnectedSocketId);
        
        if (currentUserData) {
          // Socket is still there (not replaced), so user truly disconnected
          lobbySockets.delete(disconnectedSocketId);
          broadcastOnlineUsers();
        }
        
        pendingLobbyRemovals.delete(username);
      }, LOBBY_REMOVAL_DELAY);
      
      pendingLobbyRemovals.set(username, removalTimeout);
    }
  });

  socket.on('sendChatMessage', (data) => {
    const { roomCode, message } = data;
    const room = rooms.get(roomCode);
    
    if (!room) return;
    
    // Check if chat is disabled
    if (room.chatMode === 'none') return;
    
    // Find if sender is player or spectator
    const player = getPlayerBySocketId(room, socket.id);
    const spectator = getSpectatorBySocketId(room, socket.id);
    
    if (!player && !spectator) return;
    
    const senderName = player ? player.name : spectator.name;
    const isSpectatorMessage = !!spectator;
    
    // Add message to game log
    const chatLog = {
      time: Date.now(),
      type: 'chat',
      playerName: senderName,
      message: message,
      isSpectator: isSpectatorMessage
    };
    
    room.gameLog.push(chatLog);
    
    // Emit based on chat mode
    if (room.chatMode === 'unified') {
      // Everyone sees all messages
      emitToRoom(roomCode, 'gameState');
    } else if (room.chatMode === 'separate') {
      // Players only see player chat
      // Spectators see all chat (player + spectator)
      if (isSpectatorMessage) {
        // Spectator message: send to spectators only
        room.spectators.forEach(s => {
          if (!s.hasLeft) {
            io.to(s.socketId).emit('gameState', getPublicGameState(room, s.socketId, true));
          }
        });
      } else {
        // Player message: send to all players AND all spectators
        room.players.forEach(p => {
          if (!p.hasLeft) {
            io.to(p.socketId).emit('gameState', getPublicGameState(room, p.socketId, false));
          }
        });
        room.spectators.forEach(s => {
          if (!s.hasLeft) {
            io.to(s.socketId).emit('gameState', getPublicGameState(room, s.socketId, true));
          }
        });
      }
    }
    
    // Handle lobby disconnection
    const userData = lobbySockets.get(socket.id);
    if (userData) {
      lobbySockets.delete(socket.id);
      
      // Broadcast updated user list immediately
      broadcastOnlineUsers();
      
      // Also broadcast room list in case they were in a game
      broadcastRoomList();
    }
  });
});

const PORT = process.env.PORT || 3001;

// Initialize database and start server
async function startServer() {
  try {
    await db.initDatabase();
    
    server.listen(PORT, () => {
      console.log(`Coup game server running on http://localhost:${PORT}`);
      console.log(`Open your browser to http://localhost:${PORT} to play!`);
    });
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }
}

startServer();