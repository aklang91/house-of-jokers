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

    // Bottar väljer sina kort (närmast 7)
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
        const { playerId, playerName, roomName, maxPlayers, difficulty, playWith } = data;
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
            if (room.cardsPlayedCount <= 3) {
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

        room.lastAction = { type: 'joker', playerName: room.players[pIndex].name };
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
    // 6. BOT INTELLIGENS (AI) - Uppdaterad Taktik
    // ==========================================
    async function playBotTurn(roomName, botIndex) {
        setTimeout(async () => {
            let room = await Room.findOne({ roomName });
            if (!room || room.gamePhase !== 'playing' || room.currentTurn !== botIndex) return;

            let bot = room.players[botIndex];

            // 1. Måste boten fylla på sin hand?
            if (bot.mustReplace) {
                let rIndex = Math.floor(Math.random() * bot.hand.length);
                let card = bot.hand.splice(rIndex, 1)[0];
                card.isFacedown = bot.replaceFacedown; 
                
                let insertAt = (bot.replaceIndex !== undefined) ? bot.replaceIndex : bot.buffer.length;
                bot.buffer.splice(insertAt, 0, card);
                
                bot.mustReplace = false;
                delete bot.replaceIndex; 
                
                room.markModified('players');
                await room.save();
                await nextTurn(room);
                return;
            }

            // Hjälpfunktion för att kolla om ett kort är spelbart på ett GIVET bräde
            const checkPlayability = (c, board) => {
                let state = board[c.suit];
                if (c.value === state.min - 1 && !state.jokerMin) return 'min';
                if (c.value === state.max + 1 && !state.jokerMax) return 'max';
                return null;
            };

            // Samla alla botens spelbara kort (BÅDE dolda och öppna!)
            let candidates = [];
            
            bot.buffer.forEach((c, bIndex) => {
                let side = checkPlayability(c, room.boardState);
                
                if (side) {
                    // Beräkna "framtiden" (hur brädet ser ut om vi spelar detta kort)
                    let nextBoard = JSON.parse(JSON.stringify(room.boardState));
                    if (side === 'min') nextBoard[c.suit].min = c.value;
                    if (side === 'max') nextBoard[c.suit].max = c.value;

                    let helpsSelf = false;
                    let helpsFriend = false;

                    // A: Hjälper detta kort mig själv att spela nästa runda från handen?
                    for (let hc of bot.hand) {
                        if (checkPlayability(hc, nextBoard)) { helpsSelf = true; break; }
                    }

                    // B: Hjälper detta kort en vän? (Kolla vännernas ÖPPNA kort i turordning)
                    for (let i = 1; i < room.players.length; i++) {
                        let fIndex = (botIndex + i) % room.players.length;
                        let friend = room.players[fIndex];
                        for (let fc of friend.buffer) {
                            if (!fc.isFacedown && checkPlayability(fc, nextBoard)) {
                                helpsFriend = true; break;
                            }
                        }
                        if (helpsFriend) break;
                    }

                    // Poängsätt kortet!
                    let score = 1; // Prio 4: Standarddrag
                    if (helpsFriend) score = 2; // Prio 2: Assist
                    if (helpsSelf) score = 3; // Prio 1.5: Eget momentum
                    if (helpsSelf && helpsFriend) score = 4; // Prio 1: THE WOMBO COMBO

                    candidates.push({ card: c, bIndex, side, score, isFacedown: c.isFacedown });
                }
            });

            let jokersActive = room.cardsPlayedCount >= 3;

            // Om vi har spelbara kort: Utvärdera alternativen
            if (candidates.length > 0) {
                
                // Sortera: Högst poäng först. Vid oavgjort, välj öppna kort framför dolda.
                candidates.sort((a, b) => {
                    if (b.score !== a.score) return b.score - a.score;
                    return (a.isFacedown ? 1 : 0) - (b.isFacedown ? 1 : 0);
                });

                let bestMove = candidates[0];

                // Prio 3: JOKER-MOTORN (Vi har BARA 1 kort totalt, och det har låg poäng)
                if (candidates.length === 1 && bestMove.score === 1 && jokersActive) {
                    let movableJokers = [];
                    ['♠', '♥', '♣', '♦'].forEach(s => {
                        if (room.boardState[s].jokerMin) movableJokers.push({suit: s, side: 'min'});
                        if (room.boardState[s].jokerMax) movableJokers.push({suit: s, side: 'max'});
                    });

                    if (movableJokers.length > 0) {
                        let target = getBestJokerTarget(room.boardState);
                        if (target) {
                            await executeBotAction(room, botIndex, bestMove, true, movableJokers[0], target);
                            return; // Avsluta turen här, vi försöker flytta en joker
                        }
                    }
                }

                // Annars: Försök spela vårt bästa kort (Spela-Action)
                await executeBotAction(room, botIndex, bestMove, false, null, null);
                return;
            }

            // ==========================================
            // PRIO 5 & 6: PANIK (Blockerad bot)
            // ==========================================
            let facedownIndices = [];
            let faceupIndices = [];
            bot.buffer.forEach((c, i) => {
                if (c.isFacedown) facedownIndices.push(i);
                else faceupIndices.push(i);
            });

            if (facedownIndices.length > 0) {
                // Gissa blint! (Prio 6)
                let bIndex = facedownIndices[Math.floor(Math.random() * facedownIndices.length)];
                let mockMove = { card: bot.buffer[bIndex], bIndex: bIndex, isFacedown: true, score: 0 };
                await executeBotAction(room, botIndex, mockMove, false, null, null);
            } else {
                // Helt låst, ta straff direkt (Prio 7)
                if (faceupIndices.length > 0) {
                    await applyBotPenalty(room, botIndex, false, null);
                } else {
                    room.gamePhase = 'gameover';
                    await room.save();
                    io.to(roomName).emit('gameEnded', { msg: `${bot.name} is completely stuck and out of options. You lost!` });
                    room.players.forEach(p => {
                        if(!p.isBot) sendPush(p, 'House of Jokers', `Game Over! ${bot.name} is stuck. You lost!`);
                    });
                }
            }

        }, 2500); 
    }

    // Funktion för att hitta bästa platsen att kasta en joker på
    function getBestJokerTarget(boardState) {
        let centerTargets = [];
        let openTargets = [];
        ['♠', '♥', '♣', '♦'].forEach(s => {
            let state = boardState[s];
            if (state.min === 1 && state.max === 13 && !state.jokerCenter) centerTargets.push({suit: s, side: 'center'});
            if (state.min > 1 && !state.jokerMin) openTargets.push({suit: s, side: 'min'});
            if (state.max < 13 && !state.jokerMax) openTargets.push({suit: s, side: 'max'});
        });
        return centerTargets.length > 0 ? centerTargets[0] : (openTargets.length > 0 ? openTargets[0] : null);
    }

    // Utför ett drag (med inbyggd 75% risk om kortet är gult/nedvänt)
    async function executeBotAction(room, botIndex, move, isJokerMove, jFrom, jTo) {
        let bot = room.players[botIndex];
        
        // 75% logiken
        if (move.isFacedown) {
            let guessCorrect = Math.random() < 0.75; 
            
            // Visa alltid kortet för alla!
            io.to(room.roomName).emit('showTempReveal', { roomName: room.roomName, pIndex: botIndex, bIndex: move.bIndex, card: move.card, nextState: 'normal' });

            setTimeout(async () => {
                let r2 = await Room.findOne({ roomName: room.roomName });
                if (!r2) return;
                
                if (guessCorrect && move.score > 0) { 
                    // Gissade rätt OCH valet är giltigt. Vänd upp kortet permanent!
                    r2.players[botIndex].buffer[move.bIndex].isFacedown = false;
                    r2.players[botIndex].buffer[move.bIndex].revealedThisTurn = true;
                    r2.markModified('players');
                    await r2.save();
                    io.to(r2.roomName).emit('updatePlayers', r2);
                    
                    // Gör det vi planerade att göra! (Flytta joker eller spela kortet)
                    if (isJokerMove) finalizeBotJoker(r2, botIndex, jFrom, jTo);
                    else finalizeBotPlay(r2, botIndex, move);
                } else {
                    // Gissade fel (eller mindes rätt men det var ett desperat drag som inte gick att spela). Straff!
                    await applyBotPenalty(r2, botIndex, (guessCorrect && move.score === 0), move.bIndex);
                }
            }, 3500); // 3.5 sekunder paus för att beundra dumheten/briljansen
        } else {
            // Öppet kort, inga risker, kör direkt!
            if (isJokerMove) finalizeBotJoker(room, botIndex, jFrom, jTo);
            else finalizeBotPlay(room, botIndex, move);
        }
    }

    // Genomför själva Joker-flytten och gå till nästa tur
    async function finalizeBotJoker(room, botIndex, from, to) {
        let bot = room.players[botIndex];
        if (from.side === 'min') room.boardState[from.suit].jokerMin = false;
        if (from.side === 'max') room.boardState[from.suit].jokerMax = false;
        if (to.side === 'min') room.boardState[to.suit].jokerMin = true;
        if (to.side === 'max') room.boardState[to.suit].jokerMax = true;
        if (to.side === 'center') room.boardState[to.suit].jokerCenter = true;

        room.lastAction = { type: 'joker', playerName: bot.name };
        room.lastActionTime = Date.now();
        room.markModified('boardState'); 
        await room.save();
        await nextTurn(room);
    }

    // Genomför själva Kort-spelet
    async function finalizeBotPlay(room, botIndex, move) {
        let bot = room.players[botIndex];
        room.cardsPlayedCount++;
        
        let suitState = room.boardState[move.card.suit];
        if (move.side === 'max') {
            suitState.max = move.card.value;
            if (room.cardsPlayedCount <= 3) suitState.jokerMax = true;
        } else {
            suitState.min = move.card.value;
            if (room.cardsPlayedCount <= 3) suitState.jokerMin = true;
        }

        room.lastAction = { type: 'play', playerName: bot.name, card: move.card, side: move.side };
        room.lastActionTime = Date.now();

        let playedCardWasFacedown = bot.buffer[move.bIndex].revealedThisTurn || false;
        bot.replaceIndex = move.bIndex;
        bot.buffer.splice(move.bIndex, 1);

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
            io.to(room.roomName).emit('boardUpdated', room); io.to(room.roomName).emit('updatePlayers', room);
            
            // Boten fyller på kort (Turen stannar på boten tills det är klart)
            playBotTurn(room.roomName, botIndex);
        } else {
            room.markModified('players'); room.markModified('boardState'); await room.save();
            await nextTurn(room);
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
        await nextTurn(room);
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