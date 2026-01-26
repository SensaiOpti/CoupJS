const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve the rules page
app.get('/rules.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'rules.html'));
});

// Game state storage
const rooms = new Map();

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
    players: [],
    spectators: [],
    state: 'lobby',
    deck: [],
    currentPlayerIndex: 0,
    actionInProgress: null,
    gameLog: [],
    pendingResponses: new Set(),
    useInquisitor: options.useInquisitor || false,
    allowSpectators: options.allowSpectators !== false // Default to true
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

function emitToRoom(roomCode, event) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  // Send personalized game state to each player who hasn't left
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

function getPublicGameState(room, socketId, isSpectator = false) {
  const player = getPlayerBySocketId(room, socketId);
  const spectator = getSpectatorBySocketId(room, socketId);
  
  return {
    roomCode: room.code,
    state: room.state,
    useInquisitor: room.useInquisitor,
    allowSpectators: room.allowSpectators,
    deckSize: room.deck.length,
    isSpectator: isSpectator,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      coins: p.coins,
      influenceCount: p.influences.length,
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
    })),
    spectators: room.spectators.map(s => ({
      id: s.id,
      name: s.name,
      isMe: s.socketId === socketId && isSpectator
    })),
    currentPlayerIndex: room.currentPlayerIndex,
    currentPlayerId: room.players[room.currentPlayerIndex]?.id,
    actionInProgress: room.actionInProgress,
    gameLog: room.gameLog.slice(-20),
    myPlayerId: player?.id || null
  };
}

function startGame(room) {
  if (room.players.length < 2 || room.players.length > 6) {
    return { success: false, error: 'Need 2-6 players' };
  }

  room.deck = shuffleDeck(room.useInquisitor);
  room.state = 'playing';
  room.currentPlayerIndex = 0;

  // Deal 2 cards to each player
  room.players.forEach((player, idx) => {
    player.influences = [
      { card: room.deck.pop(), revealed: false },
      { card: room.deck.pop(), revealed: false }
    ];
    player.coins = 2;
    player.alive = true;
  });

  const cardType = room.useInquisitor ? 'Inquisitor' : 'Ambassador';
  addLogToRoom(room, `🎮 Game started with ${cardType}! Each player has 2 influence cards and 2 coins.`, 'info');
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
    phase: 'waiting'
  };

  // Generate appropriate log message
  if (action === 'income') {
    addLogToRoom(room, `${player.name} takes Income (+1 coin)`, 'action', 'Income');
  } else if (action === 'foreignAid') {
    addLogToRoom(room, `${player.name} takes Foreign Aid (+2 coins)`, 'action', 'ForeignAid');
  } else if (action === 'coup') {
    addLogToRoom(room, `${player.name} launches a Coup against ${targetPlayer.name}`, 'action', 'Coup');
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
      eligibleResponders = room.players.filter(p => p.alive && p.id !== player.id);
      
      // Mark who can actually block vs who can only challenge
      room.actionInProgress.blockableByTarget = true;
      room.actionInProgress.targetCanBlock = targetId;
    } else {
      // For non-targeted actions (foreign aid, tax, etc), anyone can respond
      eligibleResponders = room.players.filter(p => p.alive && p.id !== player.id);
    }
    
    room.pendingResponses = new Set(eligibleResponders.map(p => p.id));
    
    // Set timeout for responses (10 seconds)
    setTimeout(() => {
      if (room.actionInProgress && room.actionInProgress.phase === 'waiting') {
        resolveAction(room);
        emitToRoom(room.code, 'gameState');
      }
    }, 12000); // 12 seconds to account for network latency
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

  if (response.type === 'challenge') {
    handleChallenge(room, player.id);
  } else if (response.type === 'block') {
    handleBlock(room, player.id, response.blockCard);
  } else if (response.type === 'pass') {
    // Check if all players have responded or if we're in block phase
    if (room.actionInProgress.phase === 'block') {
      // In block phase, if someone passes, check if everyone has passed
      if (room.pendingResponses.size === 0) {
        // Everyone passed on challenging the block
        addLogToRoom(room, `No one challenges the block. The action is blocked!`, 'success', room.actionInProgress.blockCard);
        room.actionInProgress = null;
        nextTurn(room);
      }
    } else if (room.pendingResponses.size === 0) {
      resolveAction(room);
    }
  }

  return { success: true };
}

function handleChallenge(room, challengerId) {
  const action = room.actionInProgress;
  const challenger = getPlayerById(room, challengerId);
  const actor = getPlayerById(room, action.playerId);
  const actionData = ACTIONS[action.action];

  addLogToRoom(room, `${challenger.name} challenges ${actor.name}!`, 'challenge');

  // Check if actor has the claimed card
  const hasCard = actor.influences.some(inf => !inf.revealed && inf.card === actionData.card);

  if (hasCard) {
    // Challenge failed - challenger loses influence
    addLogToRoom(room, `${actor.name} reveals the ${actionData.card}! The challenge fails.`, 'fail', actionData.card);
    addLogToRoom(room, `${challenger.name} loses an influence`, 'info');
    loseInfluence(room, challengerId);
    
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
    // Challenge succeeded - actor loses influence
    addLogToRoom(room, `${actor.name} doesn't have the ${actionData.card}! The challenge succeeds.`, 'success', actionData.card);
    addLogToRoom(room, `${actor.name} loses an influence and the action fails`, 'info');
    loseInfluence(room, action.playerId);
    room.actionInProgress = null;
    nextTurn(room);
  }
}

function handleBlock(room, blockerId, blockCard) {
  const action = room.actionInProgress;
  const blocker = getPlayerById(room, blockerId);
  
  addLogToRoom(room, `${blocker.name} claims to be the ${blockCard} and blocks!`, 'block', blockCard);
  
  // Now the block can be challenged by ANY player
  room.actionInProgress.phase = 'block';
  room.actionInProgress.blockerId = blockerId;
  room.actionInProgress.blockCard = blockCard;
  
  // All players except the blocker can challenge
  room.pendingResponses = new Set(
    room.players
      .filter(p => p.alive && p.id !== blockerId)
      .map(p => p.id)
  );
  
  setTimeout(() => {
    if (room.actionInProgress && room.actionInProgress.phase === 'block') {
      // Block succeeded, action cancelled
      addLogToRoom(room, `No one challenges the block. The action is blocked!`, 'success', blockCard);
      room.actionInProgress = null;
      nextTurn(room);
      emitToRoom(room.code, 'gameState');
    }
  }, 12000); // 12 seconds to account for network latency
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
  
  addLogToRoom(room, `${challenger.name} challenges the block!`, 'challenge');
  
  const hasCard = blocker.influences.some(inf => !inf.revealed && inf.card === action.blockCard);
  
  if (hasCard) {
    // Challenge failed
    addLogToRoom(room, `${blocker.name} reveals the ${action.blockCard}! The block challenge fails.`, 'fail', action.blockCard);
    addLogToRoom(room, `${challenger.name} loses an influence`, 'info');
    loseInfluence(room, challenger.id);
    
    // Return and redraw card
    const cardIndex = blocker.influences.findIndex(inf => !inf.revealed && inf.card === action.blockCard);
    if (cardIndex !== -1 && room.deck.length > 0) {
      blocker.influences[cardIndex].card = room.deck.pop();
      room.deck.unshift(action.blockCard);
      room.deck.sort(() => Math.random() - 0.5);
      addLogToRoom(room, `${blocker.name} returns the card and draws a new one`, 'info');
    }
    
    addLogToRoom(room, `The block stands. The action is blocked!`, 'success', action.blockCard);
    room.actionInProgress = null;
    nextTurn(room);
  } else {
    // Challenge succeeded
    addLogToRoom(room, `${blocker.name} doesn't have the ${action.blockCard}! The block challenge succeeds.`, 'success', action.blockCard);
    addLogToRoom(room, `${blocker.name} loses an influence and the action proceeds`, 'info');
    loseInfluence(room, action.blockerId);
    
    // Log the successful action before resolving
    const originalAction = action.action;
    if (originalAction === 'assassinate') {
      addLogToRoom(room, `The assassination proceeds`, 'success', 'Assassin');
    } else if (originalAction === 'steal') {
      addLogToRoom(room, `The steal proceeds`, 'success', 'Captain');
    } else if (originalAction === 'foreignAid') {
      addLogToRoom(room, `Foreign Aid proceeds`, 'success', 'ForeignAid');
    }
    
    resolveAction(room);
  }
  
  return { success: true };
}

function resolveAction(room) {
  const action = room.actionInProgress;
  if (!action) return;

  const actionData = ACTIONS[action.action];
  const actor = getPlayerById(room, action.playerId);
  const target = action.targetId ? getPlayerById(room, action.targetId) : null;

  // Log that action is not challenged/blocked
  if (actionData.challengeable || actionData.blockable) {
    addLogToRoom(room, `No one challenges or blocks. The action proceeds.`, 'info');
  }

  // Apply costs
  if (actionData.cost) {
    actor.coins -= actionData.cost;
  }

  // Apply effects
  switch (action.action) {
    case 'income':
      actor.coins += 1;
      addLogToRoom(room, `${actor.name} receives 1 coin`, 'success', 'Income');
      break;
    case 'foreignAid':
      actor.coins += 2;
      addLogToRoom(room, `${actor.name} receives 2 coins from Foreign Aid`, 'success', 'ForeignAid');
      break;
    case 'tax':
      actor.coins += 3;
      addLogToRoom(room, `${actor.name} receives 3 coins from Tax`, 'success', 'Duke');
      break;
    case 'steal':
      if (target) {
        const stolen = Math.min(2, target.coins);
        target.coins -= stolen;
        actor.coins += stolen;
        addLogToRoom(room, `${actor.name} steals ${stolen} coin${stolen !== 1 ? 's' : ''} from ${target.name}`, 'success', 'Captain');
      }
      break;
    case 'assassinate':
      if (target) {
        addLogToRoom(room, `${target.name} must lose an influence`, 'info');
        loseInfluence(room, target.id);
      }
      break;
    case 'exchange':
      // Draw cards from deck based on game mode
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
        addLogToRoom(room, `${target.name} must lose an influence from the Coup`, 'info', 'Coup');
        loseInfluence(room, target.id);
      }
      break;
  }

  room.actionInProgress = null;
  nextTurn(room);
}

function loseInfluence(room, playerId, count = 1) {
  const player = getPlayerById(room, playerId);
  if (!player) return;

  const unrevealed = player.influences.filter(inf => !inf.revealed);
  if (unrevealed.length > 0) {
    // Set how many influences need to be lost
    player.influencesToLose = (player.influencesToLose || 0) + count;
    player.mustRevealInfluence = true;
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

  if (forceExchange && room.deck.length > 0 && player.examinedCardIndex !== undefined) {
    // Force target to exchange the specific card that was shown
    const cardIndex = player.examinedCardIndex;
    if (cardIndex !== -1 && !target.influences[cardIndex].revealed) {
      const oldCard = target.influences[cardIndex].card;
      target.influences[cardIndex].card = room.deck.pop();
      room.deck.push(oldCard);
      room.deck.sort(() => Math.random() - 0.5);
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
  addLogToRoom(room, `${player.name} reveals and loses their ${influence.card}`, 'info', influence.card);

  const stillAlive = player.influences.some(inf => !inf.revealed);
  if (!stillAlive) {
    player.alive = false;
    player.mustRevealInfluence = false;
    player.influencesToLose = 0;
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
    addLogToRoom(room, `🎉 ${alivePlayers[0].name} wins the game! 🎉`, 'success');
    room.state = 'ended';
    emitToRoom(room.code, 'gameEnded', { winner: alivePlayers[0].name });
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

function switchToPlayer(room, socketId, name) {
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

  // Add to players
  const player = {
    id: socketId,
    socketId: socketId,
    name: name || spectator.name,
    coins: 2,
    influences: [],
    alive: true
  };

  room.players.push(player);
  addLogToRoom(room, `${player.name} joined as player`);

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
  addLogToRoom(room, `${spectator.name} is now spectating`);

  return { success: true };
}

// Socket.IO event handlers
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on('createRoom', (data, callback) => {
    const roomCode = generateRoomCode();
    const room = createRoom(roomCode, { 
      useInquisitor: data.useInquisitor || false,
      allowSpectators: data.allowSpectators !== false // Default to true
    });
    
    const player = {
      id: socket.id,
      socketId: socket.id,
      name: data.playerName || 'Player',
      coins: 2,
      influences: [],
      alive: true
    };

    room.players.push(player);
    rooms.set(roomCode, room);
    socket.join(roomCode);
    
    addLogToRoom(room, `${player.name} created the room`);
    
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
        players: room.players.map(p => ({
          id: p.id,
          name: p.name,
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

  socket.on('joinRoom', (data, callback) => {
    const { roomCode, playerName, asSpectator } = data;
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
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
        name: playerName || `Spectator ${room.spectators.length + 1}`
      };

      room.spectators.push(spectator);
      socket.join(roomCode);
      
      addLogToRoom(room, `${spectator.name} is spectating`);
      
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
        name: playerName || `Spectator ${room.spectators.length + 1}`
      };

      room.spectators.push(spectator);
      socket.join(roomCode);
      
      addLogToRoom(room, `${spectator.name} is spectating`);
      
      callback({ success: true, joinedAs: 'spectator' });
      emitToRoom(roomCode, 'gameState');
      return;
    }

    // Join as player
    const player = {
      id: socket.id,
      socketId: socket.id,
      name: playerName || `Player ${room.players.length + 1}`,
      coins: 2,
      influences: [],
      alive: true
    };

    room.players.push(player);
    socket.join(roomCode);
    
    addLogToRoom(room, `${player.name} joined the room`);
    
    callback({ success: true, joinedAs: 'player' });
    emitToRoom(roomCode, 'gameState');
  });

  socket.on('switchToPlayer', (data, callback) => {
    const { roomCode } = data;
    const room = rooms.get(roomCode);

    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    const result = switchToPlayer(room, socket.id, data.name);
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
        player.influences.forEach(inf => {
          if (!inf.revealed) {
            inf.revealed = true;
          }
        });
        player.alive = false;
        player.mustRevealInfluence = false;
        player.mustChooseExchange = false;
        player.mustChooseExamine = false;
        player.mustShowCardToExaminer = false;
        player.influencesToLose = 0;
        
        addLogToRoom(room, `${player.name} left the game and forfeits all influence!`, 'info');
        
        // Check win condition
        checkWinCondition(room);
        
        // If it was their turn, advance to next player
        if (room.currentPlayerIndex === playerIndex) {
          room.actionInProgress = null;
          nextTurn(room);
        }
        
        // Emit to other players (not this one since hasLeft = true)
        emitToRoom(roomCode, 'gameState');
      } else {
        // In lobby, remove them completely
        addLogToRoom(room, `${player.name} left`);
        room.players.splice(playerIndex, 1);
        
        if (room.players.length === 0 && room.spectators.length === 0) {
          rooms.delete(roomCode);
        } else {
          emitToRoom(roomCode, 'gameState');
        }
      }
    } else if (spectatorIndex !== -1) {
      const spectator = room.spectators[spectatorIndex];
      spectator.hasLeft = true;
      socket.leave(roomCode);
      
      addLogToRoom(room, `${spectator.name} stopped spectating`);
      room.spectators.splice(spectatorIndex, 1);
      
      if (room.players.length === 0 && room.spectators.length === 0) {
        rooms.delete(roomCode);
      } else {
        emitToRoom(roomCode, 'gameState');
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    
    // Handle player/spectator disconnection
    rooms.forEach((room, roomCode) => {
      const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
      const spectatorIndex = room.spectators.findIndex(s => s.socketId === socket.id);
      
      if (playerIndex !== -1) {
        const player = room.players[playerIndex];
        
        // Mark as left so they don't get updates
        player.hasLeft = true;
        
        if (room.state === 'playing') {
          // Player forfeits - reveal all influences and eliminate
          player.influences.forEach(inf => {
            if (!inf.revealed) {
              inf.revealed = true;
            }
          });
          player.alive = false;
          player.mustRevealInfluence = false;
          player.mustChooseExchange = false;
          player.mustChooseExamine = false;
          player.mustShowCardToExaminer = false;
          player.influencesToLose = 0;
          
          addLogToRoom(room, `${player.name} disconnected and forfeits all influence!`, 'info');
          
          // Check win condition
          checkWinCondition(room);
          
          // If it was their turn, advance to next player
          if (room.currentPlayerIndex === playerIndex) {
            room.actionInProgress = null;
            nextTurn(room);
          }
          
          emitToRoom(roomCode, 'gameState');
        } else {
          // In lobby, just remove them
          addLogToRoom(room, `${player.name} disconnected`);
          room.players.splice(playerIndex, 1);
          
          if (room.players.length === 0 && room.spectators.length === 0) {
            rooms.delete(roomCode);
          } else {
            emitToRoom(roomCode, 'gameState');
          }
        }
      } else if (spectatorIndex !== -1) {
        const spectator = room.spectators[spectatorIndex];
        spectator.hasLeft = true;
        
        addLogToRoom(room, `${spectator.name} disconnected`);
        room.spectators.splice(spectatorIndex, 1);
        
        if (room.players.length === 0 && room.spectators.length === 0) {
          rooms.delete(roomCode);
        } else {
          emitToRoom(roomCode, 'gameState');
        }
      }
    });
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Coup game server running on http://localhost:${PORT}`);
  console.log(`Open your browser to http://localhost:${PORT} to play!`);
});