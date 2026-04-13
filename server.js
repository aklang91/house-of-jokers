const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000, 
        skipMiddlewares: true,
    },
    pingTimeout: 60000, 
    pingInterval: 25000 
});

app.use(express.static('public'));

// ==========================================
// 1. KOPPLA TILL MONGODB
// ==========================================
const MONGODB_URI = process.env.MONGODB_URI; 
mongoose.connect(MONGODB_URI)
    .then(() => console.log('Connected to MongoDB!'))
    .catch(err => console.error('MongoDB connection error:', err));

// ==========================================
// 2. STÄLL IN WEB PUSH
// ==========================================
webpush.setVapidDetails(
    'mailto:test@houseofjokers.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
);

async function sendPush(player, title, body) {
    if (player && player.pushSubscription) {
        try {
            await webpush.sendNotification(player.pushSubscription, JSON.stringify({ title, body }));
        } catch (err) {
            console.error(`Fel vid push till ${player.name}:`, err);
        }
    }
}

// ==========================================
// 3. DATABAS-STRUKTUR (SCHEMA)
// ==========================================
const roomSchema = new mongoose.Schema({
    roomName: { type: String, unique: true },
    hostId: String, 
    maxPlayers: Number,
    bufferSize: Number,
    totalJokers: { type: Number, default: 3 }, // Ny variabel i databasen
    totalTurns: { type: Number, default: 0 },
    cardsPlayedCount: { type: Number, default: 0 },
    currentTurn: { type: Number, default: -1 },
    gamePhase: { type: String, default: 'waiting' },
    boardState: Object,
    lastAction: Object,
    lastActionTime: Number,
    players: Array,
    lastUpdated: { type: Number, default: Date.now }
});

roomSchema.pre('save', function(next) {
    this.lastUpdated = Date.now();
    next();
});

const Room = mongoose.model('Room', roomSchema);

// ==========================================
// 4. HJÄLPFUNKTIONER
// ==========================================
function createDeck() {
    const suits = ['♠', '♥', '♣', '♦']; 
    const deck = [];
    suits.forEach(suit => {
        for (let value = 1; value <= 13; value++) { deck.push({ suit, value }); }
    });
    return deck;
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function startRoundLogic(room) {
    room.gamePhase = 'setup';
    room.currentTurn = -1; 
    
    let deck = shuffle(createDeck()).filter(card => card.value !== 7); 
    
    let pIndex = 0;
    while(deck.length > 0) {
        room.players[pIndex].hand.push(deck.pop());
        pIndex = (pIndex + 1) % room.players.length;
    }

    const suitOrder = { '♠': 1, '♥': 2, '♣': 3, '♦': 4 };
    room.players.forEach(p => {
        p.hand.sort((a, b) => {
            if (suitOrder[a.suit] !== suitOrder[b.suit]) return suitOrder[a.suit] - suitOrder[b.suit];
            return a.value - b.value;
        });
    });

    room.players.forEach(p => {
        if (p.isBot) {
            let sortedHand = [...p.hand].sort((a, b) => Math.abs(a.value - 7) - Math.abs(b.value - 7));
            let selectedCards = sortedHand.slice(0, room.bufferSize);
            
            p.hand = p.hand.filter(c => !selectedCards.some(sc => sc.suit === c.suit && sc.value === c.value));
            
            for(let c of selectedCards) {
                c.isFacedown = true; 
                p.buffer.push(c);
            }
            p.setupConfirmed = true;
        }
    });

    room.markModified('players');
    await room.save();
    io.to(room.roomName).emit('gameState', room);

    room.players.forEach(p => {
        if (p.id !== room.hostId && !p.isBot) {
            sendPush(p, 'House of Jokers', `The game has started in ${room.roomName}! Hurry up and pick your playable cards.`);
        }
    });
}

const disconnectedPlayers = {};

// ==========================================
// 5. SOCKET.IO - SPELLOGIK
// ==========================================
io.on('connection', (socket) => {
    
    if (socket.recovered) {
        if (disconnectedPlayers[socket.id]) {
            clearTimeout(disconnectedPlayers[socket.id]);
            delete disconnectedPlayers[socket.id];
        }
    }
    
    socket.emit('yourId', socket.id);

    socket.on('savePushSubscription', async (data) => {
        let room = await Room.findOne({ roomName: data.roomName });
        if (!room) return;
        let pIndex = room.players.findIndex(p => p.id === data.playerId);
        if (pIndex !== -1) {
            room.players[pIndex].pushSubscription = data.subscription;
            room.markModified('players');
            await room.save();
        }
    });

    socket.on('rejoinGame', async (data, callback) => {
        try {
            let room = await Room.findOne({ roomName: data.roomName });
            if (!room) return callback({ success: false });
            let player = room.players.find(p => p.id === data.playerId);
            if (!player) return callback({ success: false });

            socket.join(room.roomName);
            socket.playerId = data.playerId; 
            callback({ success: true, gamePhase: room.gamePhase }); 
            
            if (room.gamePhase === 'waiting') {
                socket.emit('roomUpdate', room);
            } else {
                socket.emit('gameState', room); 
            }
        } catch(e) { callback({ success: false }); }
    });

    socket.on('createGame', async (data, callback) => {
        // Ny mottagare för jokerCount
        const { playerId, playerName, roomName, maxPlayers, difficulty, jokerCount, playWith } = data;
        let existingRoom = await Room.findOne({ roomName: roomName });
        
        if (existingRoom) {
            if (existingRoom.players.length === 0 || existingRoom.gamePhase === 'gameover') {
                await Room.deleteOne({ roomName: roomName });
            } else {
                return callback({ success: false, msg: "A room with that name already exists!" });
            }
        }

        let bufferSize = parseInt(difficulty) || 3;
        let mPlayers = parseInt(maxPlayers);
        let tJokers = parseInt(jokerCount) || 3; // Ny rad
        let isAiGame = (playWith === 'computer');

        let playersArr = [{ id: playerId, name: playerName, hand: [], buffer: [], mustReplace: false, replaceFacedown: false, setupConfirmed: false, isBot: false }];

        if (isAiGame) {
            const botNames = ["Bot Bob", "Bot Alice", "Bot Charlie", "Bot Dave"];
            for (let i = 1; i < mPlayers; i++) {
                playersArr.push({
                    id: 'bot_' + i + '_' + Date.now(),
                    name: botNames[i-1],
                    hand: [], buffer: [], mustReplace: false, replaceFacedown: false, setupConfirmed: false,
                    isBot: true
                });
            }
        }

        let newRoom = new Room({
            roomName: roomName,
            hostId: playerId, 
            maxPlayers: mPlayers,
            bufferSize: bufferSize,
            totalJokers: tJokers, // Sparar valet till databasen
            players: playersArr,
            boardState: {
                '♠': { min: 7, max: 7, jokerMin: false, jokerMax: false, jokerCenter: false },
                '♥': { min: 7, max: 7, jokerMin: false, jokerMax: false, jokerCenter: false },
                '♦': { min: 7, max: 7, jokerMin: false, jokerMax: false, jokerCenter: false },
                '♣': { min: 7, max: 7, jokerMin: false, jokerMax: false, jokerCenter: false }
            }
        });

        await newRoom.save();
        socket.join(roomName);
        socket.playerId = playerId;
        callback({ success: true, isAiGame });
        
        if (isAiGame) startRoundLogic(newRoom); 
        else io.to(roomName).emit('roomUpdate', newRoom);
    });

    socket.on('joinGame', async (data, callback) => {
        const { playerId, playerName, roomName } = data;
        let room = await Room.findOne({ roomName: roomName });

        if (!room) return callback({ success: false, msg: "The room doesn't exist!" });
        if (room.gamePhase !== 'waiting') return callback({ success: false, msg: "The game has already started!" });
        if (room.players.length >= room.maxPlayers) return callback({ success: false, msg: "The room is full!" });
        if (room.players.some(p => p.id === playerId)) return callback({ success: false, msg: "You are already in this room!"});

        room.players.push({ id: playerId, name: playerName, hand: [], buffer: [], mustReplace: false, replaceFacedown: false, setupConfirmed: false, isBot: false });
        
        room.markModified('players');
        await room.save();
        
        socket.join(roomName);
        socket.playerId = playerId;
        callback({ success: true });
        io.to(roomName).emit('roomUpdate', room);

        let hostPlayer = room.players.find(p => p.id === room.hostId);
        if (hostPlayer && hostPlayer.id !== playerId) sendPush(hostPlayer, 'House of Jokers', `${playerName} just joined your room!`);
    });

    socket.on('startRound', async (data) => {
        let room = await Room.findOne({ roomName: data.roomName });
        if (room && room.hostId === data.playerId && room.players.length === room.maxPlayers) {
            startRoundLogic(room);
        }
    });

    socket.on('confirmSetup', async (data, callback) => {
        const { roomName, playerId, buffer, hand } = data;
        let room = await Room.findOne({ roomName: roomName });
        if (!room) return;
        
        let pIndex = room.players.findIndex(p => p.id === playerId);
        if (pIndex === -1) return;

        room.players[pIndex].buffer = buffer.map(c => ({...c, isFacedown: true}));
        room.players[pIndex].hand = hand;
        room.players[pIndex].setupConfirmed = true;

        if (room.players.every(p => p.setupConfirmed)) {
            room.gamePhase = 'playing';
            room.players.forEach(p => p.buffer.forEach(c => c.isFacedown = false));

            let maxHandSize = Math.max(...room.players.map(p => p.hand.length));
            let candidates = room.players.map((p, i) => p.hand.length === maxHandSize ? i : -1).filter(i => i !== -1);
            room.currentTurn = candidates[Math.floor(Math.random() * candidates.length)];
        }
        
        room.markModified('players');
        await room.save();
        io.to(roomName).emit('updatePlayers', room);
        callback({ success: true });

        if (room.players.every(p => p.setupConfirmed) && room.players[room.currentTurn].isBot) {
            playBotTurn(roomName, room.currentTurn);
        }
    });

    socket.on('fillBuffer', async (data, callback) => {
        const { roomName, playerId, cardIndex } = data;
        let room = await Room.findOne({ roomName: roomName });
        if(!room) return;
        
        let pIndex = room.players.findIndex(p => p.id === playerId);
        if (pIndex === -1 || pIndex !== room.currentTurn) return callback({ success: false, msg: "Not your turn!" });

        let player = room.players[pIndex];

        if (player.mustReplace) {
            let card = player.hand.splice(cardIndex, 1)[0];
            card.isFacedown = player.replaceFacedown; 
            
            let insertAt = (player.replaceIndex !== undefined) ? player.replaceIndex : player.buffer.length;
            player.buffer.splice(insertAt, 0, card);
            
            player.mustReplace = false;
            delete player.replaceIndex; 
            
            room.markModified('players');
            await room.save();
            await nextTurn(room);
            callback({ success: true });
        } else {
            callback({ success: false, msg: "You cannot select more cards right now!" });
        }
    });

    socket.on('flipCard', async (data) => {
        let room = await Room.findOne({ roomName: data.roomName });
        if(!room) return;
        let pIndex = room.players.findIndex(p => p.id === data.playerId);
        if(pIndex !== -1) {
            room.players[pIndex].buffer[data.bIndex].isFacedown = true;
            room.markModified('players');
            await room.save();
            await nextTurn(room); 
        }
    });

    socket.on('flipCardAndRevert', async (data) => {
        let room = await Room.findOne({ roomName: data.roomName });
        if(!room) return;
        let player = room.players[data.pIndex];
        if (player && player.id === data.playerId) {
            if (player.buffer[data.penaltyIndex]) player.buffer[data.penaltyIndex].isFacedown = true;
            if (player.buffer[data.revertIndex]) {
                player.buffer[data.revertIndex].isFacedown = true;
                player.buffer[data.revertIndex].revealedThisTurn = false;
            }
            room.markModified('players');
            await room.save();
            await nextTurn(room);
        }
    });

    socket.on('tempReveal', (data) => {
        io.to(data.roomName).emit('showTempReveal', data);
    });

    socket.on('revealCard', async (data) => {
        let room = await Room.findOne({ roomName: data.roomName });
        if(!room) return;
        let pIndex = room.players.findIndex(p => p.id === data.playerId);
        if(pIndex !== -1) {
            room.players[pIndex].buffer[data.bIndex].isFacedown = false;
            room.players[pIndex].buffer[data.bIndex].revealedThisTurn = true; 
            room.markModified('players');
            await room.save();
            io.to(data.roomName).emit('updatePlayers', room);
        }
    });

    socket.on('gameOver', async (data) => {
        let room = await Room.findOne({ roomName: data.roomName });
        if(!room) return;
        room.gamePhase = 'gameover';
        await room.save();
        io.to(data.roomName).emit('gameEnded', { msg: data.msg });
        room.players.forEach(p => { if(!p.isBot) sendPush(p, 'House of Jokers', `Game Over! ${data.msg}`); });
    });

    socket.on('leaveGame', async (data) => {
        if (disconnectedPlayers[socket.id]) { clearTimeout(disconnectedPlayers[socket.id]); delete disconnectedPlayers[socket.id]; }
        await handlePlayerLeave(socket.id, data.roomName, data.playerId);
    });

    socket.on('playCard', async (data, callback) => {
        const { roomName, playerId, pIndex, bIndex, card, toSuit, toSide } = data;
        let room = await Room.findOne({ roomName: roomName });
        if(!room) return;

        if (room.players[pIndex].id !== playerId) return callback({success: false, msg: "Cheating!"});
        if (room.gamePhase === 'setup') return callback({ success: false, msg: "Wait until everyone has chosen their playable cards!" });
        if (card.suit !== toSuit) return callback({ success: false, msg: "Card dragged to the wrong suit!" });

        let suitState = room.boardState[card.suit];
        let isValidMove = false;

        if (toSide === 'max' && card.value === suitState.max + 1) {
            if (suitState.jokerMax) return callback({ success: false, msg: "Blocked! A joker is in the way." });
            suitState.max = card.value; isValidMove = true;
        } else if (toSide === 'min' && card.value === suitState.min - 1) {
            if (suitState.jokerMin) return callback({ success: false, msg: "Blocked! A joker is in the way." });
            suitState.min = card.value; isValidMove = true;
        }

        if (isValidMove) {
            room.cardsPlayedCount++;
            
            // NYTT: Spawnar jokrar utifrån din inställning, inte bara "3"
            if (room.cardsPlayedCount <= room.totalJokers) {
                if (toSide === 'max') suitState.jokerMax = true;
                if (toSide === 'min') suitState.jokerMin = true;
            }

            room.lastAction = { type: 'play', playerName: room.players[pIndex].name, card, side: toSide };
            room.lastActionTime = Date.now();

            let cardInBuff = room.players[pIndex].buffer[bIndex];
            let playedCardWasFacedown = cardInBuff.isFacedown || cardInBuff.revealedThisTurn;
            
            room.players[pIndex].replaceIndex = bIndex;
            room.players[pIndex].buffer.splice(bIndex, 1);

            let isWin = Object.values(room.boardState).every(s => s.min === 1 && s.max === 13);
            if (isWin) {
                room.gamePhase = 'gameover';
                room.markModified('players'); room.markModified('boardState'); await room.save();
                io.to(roomName).emit('boardUpdated', room);
                io.to(roomName).emit('gameWon', { msg: `Congratulations, you won the game together in ${room.totalTurns} turns!` });
                room.players.forEach(p => { if(!p.isBot) sendPush(p, 'House of Jokers', `VICTORY! You won the game together in ${room.totalTurns} turns!`); });
                return callback({ success: true });
            }

            if (room.players[pIndex].hand.length > 0) {
                room.players[pIndex].mustReplace = true;
                room.players[pIndex].replaceFacedown = playedCardWasFacedown;
                room.markModified('players'); room.markModified('boardState'); await room.save();
                io.to(roomName).emit('boardUpdated', room); io.to(roomName).emit('updatePlayers', room);
                callback({ success: true });
            } else {
                room.markModified('players'); room.markModified('boardState'); await room.save();
                await nextTurn(room); callback({ success: true });
            }
        } else { callback({ success: false, msg: "Invalid move! The card doesn't fit there." }); }
    });

    socket.on('moveJoker', async (data, callback) => {
        const { roomName, playerId, pIndex, fromSuit, fromSide, toSuit, toSide } = data;
        let room = await Room.findOne({ roomName: roomName });
        if(!room) return;

        if (toSide === 'min' && room.boardState[toSuit].min === 1) return callback({ success: false, msg: "That side is completed and closed!" });
        if (toSide === 'max' && room.boardState[toSuit].max === 13) return callback({ success: false, msg: "That side is completed and closed!" });
        if (toSide === 'center') {
            if (room.boardState[toSuit].min !== 1 || room.boardState[toSuit].max !== 13) return callback({ success: false, msg: "The suit is not fully complete yet!" });
        }

        if (fromSide === 'min') room.boardState[fromSuit].jokerMin = false;
        if (fromSide === 'max') room.boardState[fromSuit].jokerMax = false;
        if (toSide === 'min') room.boardState[toSuit].jokerMin = true;
        if (toSide === 'max') room.boardState[toSuit].jokerMax = true;
        if (toSide === 'center') room.boardState[toSuit].jokerCenter = true;

        room.lastAction = { type: 'joker', playerName: room.players[pIndex].name, suit: toSuit, side: toSide };
        room.lastActionTime = Date.now();
        room.markModified('boardState'); await room.save();
        await nextTurn(room); callback({ success: true });
    });

    async function nextTurn(room) {
        room.players.forEach(p => p.buffer.forEach(c => {
            if (c.revealedThisTurn) { c.isFacedown = true; c.revealedThisTurn = false; }
        }));
        
        room.totalTurns++; 

        let startIndex = room.currentTurn;
        let nextIndex = (startIndex + 1) % room.players.length;
        
        while (nextIndex !== startIndex) {
            let p = room.players[nextIndex];
            if (p.hand.length > 0 || p.buffer.length > 0) break;
            nextIndex = (nextIndex + 1) % room.players.length;
        }
        
        room.currentTurn = nextIndex;
        room.markModified('players'); await room.save();

        io.to(room.roomName).emit('boardUpdated', room);
        io.to(room.roomName).emit('updatePlayers', room);

        let nextPlayer = room.players[room.currentTurn];
        
        if (!nextPlayer.isBot) {
            sendPush(nextPlayer, 'House of Jokers', `Your turn! The board has changed in ${room.roomName}.`);
        } else {
            playBotTurn(room.roomName, room.currentTurn);
        }
    }

    // ==========================================
    // 6. BOT INTELLIGENS (AI) 
    // ==========================================
    async function playBotTurn(roomName, botIndex) {
        try {
            await sleep(1000); 

            let room = await Room.findOne({ roomName });
            if (!room || room.gamePhase !== 'playing' || room.currentTurn !== botIndex) return;

            let bot = room.players[botIndex];

            // 1. SMART PÅFYLLNING FRÅN HANDEN
            if (bot.mustReplace) {
                io.to(roomName).emit('botTaunt', `${bot.name} is selecting a card from their hand.`);
                
                await sleep(2500); 
                
                let r2 = await Room.findOne({ roomName });
                if (!r2) return;
                let b2 = r2.players[botIndex];

                let bestIndex = 0; let bestScore = -999;
                b2.hand.forEach((c, index) => {
                    let state = r2.boardState[c.suit];
                    let distance = 99; 
                    if (c.value > state.max) distance = c.value - state.max;
                    else if (c.value < state.min) distance = state.min - c.value;

                    let score = 100 - distance; 
                    let nextValOut = (c.value >= 7) ? c.value + 1 : c.value - 1;
                    let helpsFriend = false;
                    
                    for (let i = 1; i < r2.players.length; i++) {
                        let fIndex = (botIndex + i) % r2.players.length;
                        let friend = r2.players[fIndex];
                        if (friend.buffer.length > 0 && friend.buffer.some(fc => !fc.isFacedown && fc.suit === c.suit && fc.value === nextValOut)) {
                            helpsFriend = true; break;
                        }
                    }
                    if (helpsFriend) score += 50; 
                    if (score > bestScore) { bestScore = score; bestIndex = index; }
                });

                let card = b2.hand.splice(bestIndex, 1)[0];
                card.isFacedown = b2.replaceFacedown; 
                let insertAt = (b2.replaceIndex !== undefined) ? b2.replaceIndex : b2.buffer.length;
                b2.buffer.splice(insertAt, 0, card);
                b2.mustReplace = false; delete b2.replaceIndex; 
                
                r2.markModified('players'); 
                await r2.save(); 
                
                io.to(roomName).emit('boardUpdated', r2);
                io.to(roomName).emit('updatePlayers', r2);
                
                await sleep(1500);
                
                let r3 = await Room.findOne({ roomName });
                if(r3) await nextTurn(r3); 
                
                return;
            }

            // --- HJÄLPFUNKTIONER FÖR AI ---
            const checkPlayability = (c, board) => {
                let state = board[c.suit];
                if (c.value === state.min - 1 && !state.jokerMin) return 'min';
                if (c.value === state.max + 1 && !state.jokerMax) return 'max';
                return null;
            };

            const getOpenPlayableCount = (player, board) => {
                let count = 0;
                player.buffer.forEach(c => { if (!c.isFacedown && checkPlayability(c, board)) count++; });
                return count;
            };

            const simulatePlay = (board, engine) => {
                let nextBoard = JSON.parse(JSON.stringify(board));
                if (engine.side === 'min') nextBoard[engine.card.suit].min = engine.card.value;
                if (engine.side === 'max') nextBoard[engine.card.suit].max = engine.card.value;
                return nextBoard;
            };

            const simulateJoker = (board, jFrom, jTo) => {
                let nextBoard = JSON.parse(JSON.stringify(board));
                if (jFrom.side === 'min') nextBoard[jFrom.suit].jokerMin = false;
                if (jFrom.side === 'max') nextBoard[jFrom.suit].jokerMax = false;
                if (jTo.side === 'min') nextBoard[jTo.suit].jokerMin = true;
                if (jTo.side === 'max') nextBoard[jTo.suit].jokerMax = true;
                if (jTo.side === 'center') nextBoard[jTo.suit].jokerCenter = true;
                return nextBoard;
            };

            let myPlayableEngines = [];
            bot.buffer.forEach((c, bIndex) => {
                let side = checkPlayability(c, room.boardState);
                if (side) myPlayableEngines.push({ card: c, bIndex, side, isFacedown: c.isFacedown });
            });
            myPlayableEngines.sort((a, b) => (a.isFacedown ? 1 : 0) - (b.isFacedown ? 1 : 0));

            // NYTT: AI kollar rummets inställning för jokrar!
            let jokersActive = room.cardsPlayedCount >= room.totalJokers;
            
            let activeTeammates = [];
            for (let i = 1; i < room.players.length; i++) {
                let t = room.players[(botIndex + i) % room.players.length];
                if (t.hand.length > 0 || t.buffer.length > 0) activeTeammates.push(t);
            }
            
            let nextPlayer = activeTeammates.length > 0 ? activeTeammates[0] : null;
            let allTeammatesCanPlay = activeTeammates.every(t => getOpenPlayableCount(t, room.boardState) > 0);
            let targetPlayerInCrisis = activeTeammates.find(t => getOpenPlayableCount(t, room.boardState) === 0);

            function findBestJokerMove(boardState, engine, conditionFn) {
                let movableJokers = [];
                ['♠', '♥', '♣', '♦'].forEach(s => {
                    if (boardState[s].jokerMin) movableJokers.push({suit: s, side: 'min'});
                    if (boardState[s].jokerMax) movableJokers.push({suit: s, side: 'max'});
                });

                let targets = [];
                ['♠', '♥', '♣', '♦'].forEach(s => {
                    let state = boardState[s];
                    if (state.min === 1 && state.max === 13 && !state.jokerCenter) targets.push({suit: s, side: 'center', prio: 1});
                    else {
                        if (state.min > 1 && !state.jokerMin) targets.push({suit: s, side: 'min', prio: 2});
                        if (state.max < 13 && !state.jokerMax) targets.push({suit: s, side: 'max', prio: 2});
                    }
                });
                targets.sort((a, b) => a.prio - b.prio);

                for (let jFrom of movableJokers) {
                    for (let jTo of targets) {
                        let nextBoard = simulateJoker(boardState, jFrom, jTo);
                        
                        let sabotage = false;
                        if (nextPlayer) {
                            let before = getOpenPlayableCount(nextPlayer, boardState);
                            let after = getOpenPlayableCount(nextPlayer, nextBoard);
                            if (before > 0 && after === 0) sabotage = true;
                        }
                        if (sabotage) continue; 

                        if (conditionFn(nextBoard)) {
                            return { type: 'joker', engine: engine, jFrom, jTo };
                        }
                    }
                }
                return null;
            }

            let chosenAction = null;
            let tauntMsg = "";

            if (bot.buffer.length === 1 && bot.hand.length === 0 && myPlayableEngines.length === 1) {
                chosenAction = { type: 'play', engine: myPlayableEngines[0] };
                tauntMsg = `${bot.name} plays their final card!`;
            }

            if (!chosenAction && myPlayableEngines.length > 0) {
                
                if (allTeammatesCanPlay || activeTeammates.length === 0) {
                    // SCENARIO A: Fredstid
                    for (let eng of myPlayableEngines) {
                        let nextBoard = simulatePlay(room.boardState, eng);
                        let unlocksOwn = false;
                        bot.buffer.forEach((c, idx) => {
                            if (idx !== eng.bIndex && !checkPlayability(c, room.boardState) && checkPlayability(c, nextBoard)) unlocksOwn = true;
                        });
                        bot.hand.forEach(hc => {
                            if (checkPlayability(hc, nextBoard)) unlocksOwn = true;
                        });

                        if (unlocksOwn) { 
                            chosenAction = { type: 'play', engine: eng }; 
                            tauntMsg = `${bot.name} plays a card to set up their next move.`;
                            break; 
                        }
                    }
                    
                    if (!chosenAction && nextPlayer) {
                        for (let eng of myPlayableEngines) {
                            let nextBoard = simulatePlay(room.boardState, eng);
                            if (getOpenPlayableCount(nextPlayer, nextBoard) > getOpenPlayableCount(nextPlayer, room.boardState)) {
                                chosenAction = { type: 'play', engine: eng }; 
                                tauntMsg = `${bot.name} plays a card to give the next player more options.`;
                                break; 
                            }
                        }
                    }

                    if (!chosenAction) {
                        chosenAction = { type: 'play', engine: myPlayableEngines[0] };
                        tauntMsg = `${bot.name} plays a card.`;
                    }

                } else {
                    // SCENARIO B: Krishantering
                    for (let eng of myPlayableEngines) {
                        let nextBoard = simulatePlay(room.boardState, eng);
                        if (getOpenPlayableCount(targetPlayerInCrisis, nextBoard) > 0) {
                            chosenAction = { type: 'play', engine: eng }; 
                            tauntMsg = `${bot.name} plays a card to rescue a blocked teammate.`;
                            break; 
                        }
                    }

                    if (!chosenAction && jokersActive) {
                        let targetIndexInTeammates = activeTeammates.findIndex(t => t.id === targetPlayerInCrisis.id);
                        let intermediateTeammates = activeTeammates.slice(0, targetIndexInTeammates);
                        
                        let canIntermediateSave = false;
                        for (let intermediate of intermediateTeammates) {
                            let openEngines = [];
                            intermediate.buffer.forEach((c, bIndex) => {
                                let side = checkPlayability(c, room.boardState);
                                if (side && !c.isFacedown) openEngines.push({card: c, side: side});
                            });

                            for (let eng of openEngines) {
                                let simulatedBoard = simulatePlay(room.boardState, eng);
                                if (getOpenPlayableCount(targetPlayerInCrisis, simulatedBoard) > 0) {
                                    canIntermediateSave = true;
                                    break;
                                }
                            }
                            if (canIntermediateSave) break;
                        }

                        if (!canIntermediateSave) {
                            let jokerMove = findBestJokerMove(room.boardState, myPlayableEngines[0], (nextBoard) => {
                                return getOpenPlayableCount(targetPlayerInCrisis, nextBoard) > 0;
                            }); 
                            if (jokerMove) {
                                chosenAction = jokerMove;
                                tauntMsg = `${bot.name} moves a joker to rescue a blocked teammate.`;
                            }
                        }
                    }

                    if (!chosenAction) {
                        chosenAction = { type: 'play', engine: myPlayableEngines[0] };
                        tauntMsg = `${bot.name} plays a card.`;
                    }
                }
            }

            if (chosenAction) {
                if (!chosenAction.engine.isFacedown) {
                    io.to(roomName).emit('botTaunt', tauntMsg);
                    await sleep(3000);
                    
                    let r2 = await Room.findOne({ roomName });
                    if(r2) await executeBotAction(r2, botIndex, chosenAction);
                } else {
                    await executeBotAction(room, botIndex, chosenAction);
                }
                return;
            }

            // PANIK
            let facedownIndices = [];
            let faceupIndices = [];
            bot.buffer.forEach((c, i) => {
                if (c.isFacedown) facedownIndices.push(i);
                else faceupIndices.push(i);
            });

            if (facedownIndices.length > 0) {
                let bIndex = facedownIndices[Math.floor(Math.random() * facedownIndices.length)];
                let mockAction = { type: 'play', engine: { card: bot.buffer[bIndex], bIndex: bIndex, isFacedown: true } };
                await executeBotAction(room, botIndex, mockAction);
            } else {
                if (faceupIndices.length > 0) {
                    io.to(roomName).emit('botTaunt', `${bot.name} is completely blocked and must take a penalty.`);
                    await sleep(3500); 
                    let r2 = await Room.findOne({ roomName });
                    if(r2) await applyBotPenalty(r2, botIndex, false, null);
                } else {
                    room.gamePhase = 'gameover';
                    await room.save();
                    io.to(roomName).emit('gameEnded', { msg: `${bot.name} is completely stuck and out of options. You lost!` });
                    room.players.forEach(p => {
                        if(!p.isBot) sendPush(p, 'House of Jokers', `Game Over! ${bot.name} is stuck. You lost!`);
                    });
                }
            }

        } catch (e) {
            console.error("AI Error i playBotTurn:", e);
        }
    }

    async function executeBotAction(room, botIndex, action) {
        let bot = room.players[botIndex];
        let engine = action.engine;
        
        if (engine.isFacedown) {
            let guessCorrect = Math.random() < 0.80; 
            
            io.to(room.roomName).emit('botTaunt', `${bot.name} is attempting to play a face-down card...`);

            await sleep(2500);

            io.to(room.roomName).emit('showTempReveal', { roomName: room.roomName, pIndex: botIndex, bIndex: engine.bIndex, card: engine.card, nextState: 'normal' });

            await sleep(3500);
            
            let r2 = await Room.findOne({ roomName: room.roomName });
            if (!r2) return;
            
            let checkPlayability = (c, board) => {
                let state = board[c.suit];
                if (c.value === state.min - 1 && !state.jokerMin) return 'min';
                if (c.value === state.max + 1 && !state.jokerMax) return 'max';
                return null;
            };
            let isPlayable = checkPlayability(engine.card, r2.boardState) !== null;

            if (guessCorrect && isPlayable) { 
                io.to(r2.roomName).emit('botTaunt', `${bot.name} correctly remembered the card.`);
                
                r2.players[botIndex].buffer[engine.bIndex].isFacedown = false;
                r2.players[botIndex].buffer[engine.bIndex].revealedThisTurn = true;
                r2.markModified('players');
                await r2.save();
                io.to(r2.roomName).emit('updatePlayers', r2);
                
                await sleep(2500);
                
                if (action.type === 'joker') await finalizeBotJoker(r2, botIndex, action.jFrom, action.jTo);
                else await finalizeBotPlay(r2, botIndex, engine);

            } else {
                if (!guessCorrect) {
                    io.to(r2.roomName).emit('botTaunt', `${bot.name} guessed incorrectly and takes a penalty.`);
                } else {
                    io.to(r2.roomName).emit('botTaunt', `${bot.name} remembered the card, but it cannot be played. Taking a penalty.`);
                }
                
                await applyBotPenalty(r2, botIndex, (guessCorrect && !isPlayable), engine.bIndex);
            }
        } else {
            if (action.type === 'joker') await finalizeBotJoker(room, botIndex, action.jFrom, action.jTo);
            else await finalizeBotPlay(room, botIndex, engine);
        }
    }

    async function finalizeBotJoker(room, botIndex, from, to) {
        let bot = room.players[botIndex];
        if (from.side === 'min') room.boardState[from.suit].jokerMin = false;
        if (from.side === 'max') room.boardState[from.suit].jokerMax = false;
        if (to.side === 'min') room.boardState[to.suit].jokerMin = true;
        if (to.side === 'max') room.boardState[to.suit].jokerMax = true;
        if (to.side === 'center') room.boardState[to.suit].jokerCenter = true;

        room.lastAction = { type: 'joker', playerName: bot.name, suit: to.suit, side: to.side };
        room.lastActionTime = Date.now();
        room.markModified('boardState'); 
        await room.save();
        
        io.to(room.roomName).emit('boardUpdated', room); 
        io.to(room.roomName).emit('updatePlayers', room);
        
        await sleep(3000);
        let r2 = await Room.findOne({ roomName: room.roomName });
        if(r2) await nextTurn(r2);
    }

    async function finalizeBotPlay(room, botIndex, engine) {
        let bot = room.players[botIndex];
        room.cardsPlayedCount++;
        
        let suitState = room.boardState[engine.card.suit];
        if (engine.side === 'max') {
            suitState.max = engine.card.value;
            // NYTT: AI kollar rummets inställning för att spawna jokrar
            if (room.cardsPlayedCount <= room.totalJokers) suitState.jokerMax = true;
        } else {
            suitState.min = engine.card.value;
            if (room.cardsPlayedCount <= room.totalJokers) suitState.jokerMin = true;
        }

        room.lastAction = { type: 'play', playerName: bot.name, card: engine.card, side: engine.side };
        room.lastActionTime = Date.now();

        let playedCardWasFacedown = bot.buffer[engine.bIndex].revealedThisTurn || false;
        bot.replaceIndex = engine.bIndex;
        bot.buffer.splice(engine.bIndex, 1);

        let isWin = Object.values(room.boardState).every(s => s.min === 1 && s.max === 13);
        if (isWin) {
            room.gamePhase = 'gameover';
            room.markModified('players'); room.markModified('boardState'); await room.save();
            io.to(room.roomName).emit('boardUpdated', room);
            io.to(room.roomName).emit('gameWon', { msg: `Congratulations, you won the game together in ${room.totalTurns} turns!` });
            room.players.forEach(p => {
                if(!p.isBot) sendPush(p, 'House of Jokers', `VICTORY! You won the game together in ${room.totalTurns} turns!`);
            });
            return;
        }

        if (bot.hand.length > 0) {
            bot.mustReplace = true;
            bot.replaceFacedown = playedCardWasFacedown;
            room.markModified('players'); room.markModified('boardState'); await room.save();
            
            io.to(room.roomName).emit('boardUpdated', room); 
            io.to(room.roomName).emit('updatePlayers', room); 
            
            await sleep(3000);
            await playBotTurn(room.roomName, botIndex);
        } else {
            room.markModified('players'); room.markModified('boardState'); await room.save();
            
            io.to(room.roomName).emit('boardUpdated', room); 
            io.to(room.roomName).emit('updatePlayers', room);
            
            await sleep(3000);
            let r2 = await Room.findOne({ roomName: room.roomName });
            if(r2) await nextTurn(r2);
        }
    }

    async function applyBotPenalty(room, botIndex, needsRevert, revertIndex) {
        let bot = room.players[botIndex];
        let faceupIndices = [];
        bot.buffer.forEach((c, i) => {
            if (!c.isFacedown && i !== revertIndex) faceupIndices.push(i);
        });

        if (faceupIndices.length === 0) {
            room.gamePhase = 'gameover';
            await room.save();
            io.to(room.roomName).emit('gameEnded', { msg: `${bot.name} failed and has no cards to take a penalty with. You lost!` });
            room.players.forEach(p => {
                if(!p.isBot) sendPush(p, 'House of Jokers', `Game Over! ${bot.name} failed. You lost!`);
            });
            return;
        }

        let penaltyIndex = faceupIndices[Math.floor(Math.random() * faceupIndices.length)];
        bot.buffer[penaltyIndex].isFacedown = true;
        
        if (needsRevert && revertIndex !== null) {
            bot.buffer[revertIndex].isFacedown = true;
            bot.buffer[revertIndex].revealedThisTurn = false;
        }

        room.markModified('players');
        await room.save();
        
        io.to(room.roomName).emit('boardUpdated', room); 
        io.to(room.roomName).emit('updatePlayers', room); 
        
        await sleep(3000);
        let r2 = await Room.findOne({ roomName: room.roomName });
        if(r2) await nextTurn(r2);
    }

    // --- HANDLE PLAYER LEAVE ---
    async function handlePlayerLeave(socketId, specificRoom = null, explicitPlayerId = null) {
        let room = await Room.findOne({ roomName: specificRoom });
        if (!room) return;

        let pIdToFind = explicitPlayerId;
        if (!pIdToFind) {
            let socketObj = Array.from(io.sockets.sockets.values()).find(s => s.id === socketId);
            pIdToFind = socketObj ? socketObj.playerId : null;
        }
        
        if (!pIdToFind) return;

        let playerIndex = room.players.findIndex(p => p.id === pIdToFind);
        if (playerIndex !== -1) { 
            let player = room.players[playerIndex];
            
            if (room.gamePhase !== 'waiting' && room.gamePhase !== 'gameover') {
                io.to(room.roomName).emit('playerLeft', { msg: `${player.name} chose to leave. You have lost.` });
                
                room.players.forEach(p => {
                    if (p.id !== player.id && !p.isBot) {
                        sendPush(p, 'House of Jokers', `Game Over! ${player.name} abandoned the game. You lost!`);
                    }
                });

                await Room.deleteOne({ roomName: room.roomName }); 
                return;
            }
            
            room.players.splice(playerIndex, 1);

            if (room.players.length === 0 || room.gamePhase === 'gameover') {
                await Room.deleteOne({ roomName: room.roomName });
            } else {
                if (room.hostId === pIdToFind) room.hostId = room.players[0].id;
                room.markModified('players');
                await room.save();
                io.to(room.roomName).emit('roomUpdate', room);
            }
        }
    }

    socket.on('disconnect', () => {
        console.log('A device disconnected:', socket.id);
    });
});

// ==========================================
// 7. VAKTMÄSTAREN - Städar gamla rum (72 timmar)
// ==========================================
setInterval(async () => {
    const expireTime = Date.now() - (72 * 60 * 60 * 1000); 
    try {
        const result = await Room.deleteMany({ lastUpdated: { $lt: expireTime } });
        if (result.deletedCount > 0) {
            console.log(`🧹 Vaktmästaren städade precis bort ${result.deletedCount} inaktiva rum (äldre än 72h).`);
        }
    } catch (err) {
        console.error("Fel vid städning av rum:", err);
    }
}, 60 * 60 * 1000); 

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`House of Jokers asynkron server rullar på port ${PORT}`);
});