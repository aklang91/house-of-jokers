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
}

const disconnectedPlayers = {};

// ==========================================
// 5. SOCKET.IO - SPELLOGIK
// ==========================================
io.on('connection', (socket) => {
    
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
        const { playerName, roomName, maxPlayers, difficulty, playWith } = data;
        let existingRoom = await Room.findOne({ roomName: roomName });
        if (existingRoom) await Room.deleteOne({ roomName: roomName });

        let bufferSize = parseInt(difficulty) || 3;
        let mPlayers = parseInt(maxPlayers);
        let playersArr = [{ id: data.playerId, name: playerName, hand: [], buffer: [], mustReplace: false, replaceFacedown: false, setupConfirmed: false, isBot: false }];

        if (playWith === 'computer') {
            const botNames = ["Bot Bob", "Bot Alice", "Bot Charlie", "Bot Dave"];
            for (let i = 1; i < mPlayers; i++) {
                playersArr.push({ id: 'bot_' + i + '_' + Date.now(), name: botNames[i-1], hand: [], buffer: [], mustReplace: false, replaceFacedown: false, setupConfirmed: false, isBot: true });
            }
        }

        let newRoom = new Room({
            roomName: roomName, hostId: data.playerId, maxPlayers: mPlayers, bufferSize: bufferSize, players: playersArr,
            boardState: { '♠': { min: 7, max: 7, jokerMin: false, jokerMax: false, jokerCenter: false }, '♥': { min: 7, max: 7, jokerMin: false, jokerMax: false, jokerCenter: false }, '♦': { min: 7, max: 7, jokerMin: false, jokerMax: false, jokerCenter: false }, '♣': { min: 7, max: 7, jokerMin: false, jokerMax: false, jokerCenter: false } }
        });

        await newRoom.save();
        socket.join(roomName);
        callback({ success: true, isAiGame: (playWith === 'computer') });
        if (playWith === 'computer') startRoundLogic(newRoom); 
        else io.to(roomName).emit('roomUpdate', newRoom);
    });

    socket.on('joinGame', async (data, callback) => {
        let room = await Room.findOne({ roomName: data.roomName });
        if (!room) return callback({ success: false, msg: "Room missing" });
        room.players.push({ id: data.playerId, name: data.playerName, hand: [], buffer: [], mustReplace: false, replaceFacedown: false, setupConfirmed: false, isBot: false });
        room.markModified('players'); await room.save();
        socket.join(data.roomName);
        callback({ success: true });
        io.to(data.roomName).emit('roomUpdate', room);
    });

    socket.on('startRound', async (data) => {
        let room = await Room.findOne({ roomName: data.roomName });
        if (room && room.hostId === data.playerId) startRoundLogic(room);
    });

    socket.on('confirmSetup', async (data, callback) => {
        let room = await Room.findOne({ roomName: data.roomName });
        let pIndex = room.players.findIndex(p => p.id === data.playerId);
        room.players[pIndex].buffer = data.buffer.map(c => ({...c, isFacedown: true}));
        room.players[pIndex].hand = data.hand;
        room.players[pIndex].setupConfirmed = true;

        if (room.players.every(p => p.setupConfirmed)) {
            room.gamePhase = 'playing';
            room.players.forEach(p => p.buffer.forEach(c => c.isFacedown = false));
            let maxHandSize = Math.max(...room.players.map(p => p.hand.length));
            let candidates = room.players.map((p, i) => p.hand.length === maxHandSize ? i : -1).filter(i => i !== -1);
            room.currentTurn = candidates[Math.floor(Math.random() * candidates.length)];
        }
        room.markModified('players'); await room.save();
        io.to(data.roomName).emit('updatePlayers', room);
        callback({ success: true });
        if (room.players.every(p => p.setupConfirmed) && room.players[room.currentTurn].isBot) playBotTurn(data.roomName, room.currentTurn);
    });

    socket.on('playCard', async (data, callback) => {
        let room = await Room.findOne({ roomName: data.roomName });
        let suitState = room.boardState[data.card.suit];
        let isValidMove = false;
        if (data.toSide === 'max' && data.card.value === suitState.max + 1 && !suitState.jokerMax) { suitState.max = data.card.value; isValidMove = true; }
        else if (data.toSide === 'min' && data.card.value === suitState.min - 1 && !suitState.jokerMin) { suitState.min = data.card.value; isValidMove = true; }

        if (isValidMove) {
            room.cardsPlayedCount++;
            if (room.cardsPlayedCount <= 3) { if (data.toSide === 'max') suitState.jokerMax = true; else suitState.jokerMin = true; }
            room.lastAction = { type: 'play', playerName: room.players[data.pIndex].name, card: data.card, side: data.toSide };
            room.lastActionTime = Date.now();
            let cardWasFacedown = room.players[data.pIndex].buffer[data.bIndex].isFacedown || room.players[data.pIndex].buffer[data.bIndex].revealedThisTurn;
            room.players[data.pIndex].replaceIndex = data.bIndex;
            room.players[data.pIndex].buffer.splice(data.bIndex, 1);
            
            let isWin = Object.values(room.boardState).every(s => s.min === 1 && s.max === 13);
            if (isWin) {
                room.gamePhase = 'gameover'; room.markModified('players'); room.markModified('boardState'); await room.save();
                io.to(data.roomName).emit('boardUpdated', room); io.to(data.roomName).emit('gameWon', { msg: "Victory!" });
                return callback({ success: true });
            }
            if (room.players[data.pIndex].hand.length > 0) {
                room.players[data.pIndex].mustReplace = true; room.players[data.pIndex].replaceFacedown = cardWasFacedown;
                room.markModified('players'); room.markModified('boardState'); await room.save();
                io.to(data.roomName).emit('boardUpdated', room); io.to(data.roomName).emit('updatePlayers', room);
                callback({ success: true });
            } else {
                room.markModified('players'); room.markModified('boardState'); await room.save();
                await nextTurn(room); callback({ success: true });
            }
        } else callback({ success: false, msg: "Invalid move" });
    });

    socket.on('moveJoker', async (data, callback) => {
        let room = await Room.findOne({ roomName: data.roomName });
        if (data.fromSide === 'min') room.boardState[data.fromSuit].jokerMin = false; else room.boardState[data.fromSuit].jokerMax = false;
        if (data.toSide === 'min') room.boardState[data.toSuit].jokerMin = true; else if (data.toSide === 'max') room.boardState[data.toSuit].jokerMax = true; else room.boardState[data.toSuit].jokerCenter = true;
        room.lastAction = { type: 'joker', playerName: room.players[data.pIndex].name, suit: data.toSuit, side: data.toSide };
        room.lastActionTime = Date.now();
        room.markModified('boardState'); await room.save();
        await nextTurn(room); callback({ success: true });
    });

    async function nextTurn(room) {
        room.players.forEach(p => p.buffer.forEach(c => { if (c.revealedThisTurn) { c.isFacedown = true; c.revealedThisTurn = false; } }));
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
        if (room.players[room.currentTurn].isBot) playBotTurn(room.roomName, room.currentTurn);
    }

    // ==========================================
    // 6. BOT INTELLIGENS (AI) - V8 (BOMBSÄKER)
    // ==========================================
    async function playBotTurn(roomName, botIndex) {
        try {
            await sleep(1000);
            let room = await Room.findOne({ roomName });
            if (!room || room.gamePhase !== 'playing' || room.currentTurn !== botIndex) return;

            let bot = room.players[botIndex];

            // --- A: SMART PÅFYLLNING ---
            if (bot.mustReplace) {
                io.to(roomName).emit('botTaunt', `${bot.name} fyller på sin hand.`);
                await sleep(2000);
                
                let bestIndex = 0; let bestScore = -999;
                bot.hand.forEach((c, index) => {
                    let state = room.boardState[c.suit];
                    let dist = (c.value > state.max) ? c.value - state.max : (c.value < state.min ? state.min - c.value : 99);
                    let score = 100 - dist;
                    for (let i = 1; i < room.players.length; i++) {
                        let friend = room.players[(botIndex + i) % room.players.length];
                        let nextVal = (c.value >= 7) ? c.value + 1 : c.value - 1;
                        if (friend.buffer.some(fc => !fc.isFacedown && fc.suit === c.suit && fc.value === nextVal)) score += 50;
                    }
                    if (score > bestScore) { bestScore = score; bestIndex = index; }
                });

                let card = bot.hand.splice(bestIndex, 1)[0];
                card.isFacedown = bot.replaceFacedown;
                bot.buffer.splice(bot.replaceIndex || bot.buffer.length, 0, card);
                bot.mustReplace = false; delete bot.replaceIndex;
                
                room.markModified('players'); await room.save();
                io.to(roomName).emit('boardUpdated', room);
                io.to(roomName).emit('updatePlayers', room); // FIX: Synka direkt
                
                await sleep(1500);
                return await nextTurn(room);
            }

            // --- B: ANALYS & STRATEGI ---
            const checkPlayability = (c, board) => {
                let s = board[c.suit];
                if (c.value === s.min - 1 && !s.jokerMin) return 'min';
                if (c.value === s.max + 1 && !s.jokerMax) return 'max';
                return null;
            };
            const getOpenCount = (p, board) => p.buffer.filter(c => !c.isFacedown && checkPlayability(c, board)).length;

            let myPlayables = [];
            bot.buffer.forEach((c, bIndex) => {
                let side = checkPlayability(c, room.boardState);
                if (side) myPlayables.push({ card: c, bIndex, side, isFacedown: c.isFacedown });
            });
            myPlayables.sort((a, b) => (a.isFacedown ? 1 : 0) - (b.isFacedown ? 1 : 0));

            let teammates = [];
            for (let i = 1; i < room.players.length; i++) {
                let t = room.players[(botIndex + i) % room.players.length];
                if (t.hand.length > 0 || t.buffer.length > 0) teammates.push(t);
            }

            let crisisPlayer = teammates.find(t => getOpenCount(t, room.boardState) === 0);
            let action = null; let msg = "";

            // 0. VINSTKOLL
            if (bot.buffer.length === 1 && bot.hand.length === 0 && myPlayables.length === 1) {
                action = { type: 'play', engine: myPlayables[0] }; msg = `${bot.name} lägger sista kortet!`;
            }

            if (!action && myPlayables.length > 0) {
                if (!crisisPlayer) {
                    // SCENARIO A: FRED
                    for (let eng of myPlayables) {
                        let nextB = JSON.parse(JSON.stringify(room.boardState));
                        nextB[eng.card.suit][eng.side] = eng.card.value;
                        if (bot.buffer.some((c, i) => i !== eng.bIndex && checkPlayability(c, nextB)) || bot.hand.some(hc => checkPlayability(hc, nextB))) {
                            action = { type: 'play', engine: eng }; msg = `${bot.name} bygger för sig själv.`; break;
                        }
                    }
                    if (!action && teammates.length > 0) {
                        for (let eng of myPlayables) {
                            let nextB = JSON.parse(JSON.stringify(room.boardState)); nextB[eng.card.suit][eng.side] = eng.card.value;
                            if (getOpenCount(teammates[0], nextB) > getOpenCount(teammates[0], room.boardState)) {
                                action = { type: 'play', engine: eng }; msg = `${bot.name} hjälper nästa spelare.`; break;
                            }
                        }
                    }
                    if (!action) { action = { type: 'play', engine: myPlayables[0] }; msg = `${bot.name} lägger ett kort.`; }
                } else {
                    // SCENARIO B: KRIS
                    for (let eng of myPlayables) {
                        let nextB = JSON.parse(JSON.stringify(room.boardState)); nextB[eng.card.suit][eng.side] = eng.card.value;
                        if (getOpenCount(crisisPlayer, nextB) > 0) { action = { type: 'play', engine: eng }; msg = `${bot.name} räddar en kompis!`; break; }
                    }
                    if (!action && room.cardsPlayedCount >= 3) {
                        // JOKER-KOLL: Kan nån mellan oss rädda?
                        let idx = teammates.findIndex(t => t.id === crisisPlayer.id);
                        let canOthersSave = teammates.slice(0, idx).some(t => t.buffer.some(c => !c.isFacedown && checkPlayability(c, room.boardState)));
                        
                        if (!canOthersSave) {
                            let movableJokers = [];
                            ['♠', '♥', '♣', '♦'].forEach(s => { if (room.boardState[s].jokerMin) movableJokers.push({s, side:'min'}); if (room.boardState[s].jokerMax) movableJokers.push({s, side:'max'}); });
                            let targets = [];
                            ['♠', '♥', '♣', '♦'].forEach(s => { let st = room.boardState[s]; if (st.min === 1 && st.max === 13 && !st.jokerCenter) targets.push({s, side:'center'}); else { if (st.min > 1 && !st.jokerMin) targets.push({s, side:'min'}); if (st.max < 13 && !st.jokerMax) targets.push({s, side:'max'}); } });
                            
                            for (let jF of movableJokers) {
                                for (let jT of targets) {
                                    let nextB = JSON.parse(JSON.stringify(room.boardState));
                                    nextB[jF.s]['joker' + jF.side.charAt(0).toUpperCase() + jF.side.slice(1)] = false;
                                    nextB[jT.s]['joker' + jT.side.charAt(0).toUpperCase() + jT.side.slice(1)] = true;
                                    if (getOpenCount(crisisPlayer, nextB) > 0) {
                                        let sabotage = teammates.some(t => getOpenCount(t, room.boardState) > 0 && getOpenCount(t, nextB) === 0);
                                        if (!sabotage) { action = { type: 'joker', engine: myPlayables[0], jFrom: {suit:jF.s, side:jF.side}, jTo: {suit:jT.s, side:jT.side} }; msg = `${bot.name} flyttar jokern för att rädda en vän.`; break; }
                                    }
                                }
                                if (action) break;
                            }
                        }
                    }
                    if (!action) { action = { type: 'play', engine: myPlayables[0] }; msg = `${bot.name} lägger ett kort.`; }
                }
            }

            // --- C: UTFÖRANDE ---
            if (action) {
                if (action.engine.isFacedown) {
                    io.to(roomName).emit('botTaunt', `${bot.name} försöker gissa ett dolt kort...`);
                    await sleep(2500);
                    io.to(roomName).emit('showTempReveal', { pIndex: botIndex, bIndex: action.engine.bIndex, card: action.engine.card, nextState: 'normal' });
                    await sleep(3500);
                    if (Math.random() < 0.75 && checkPlayability(action.engine.card, room.boardState)) {
                        io.to(roomName).emit('botTaunt', `${bot.name} gissade rätt!`);
                        bot.buffer[action.engine.bIndex].isFacedown = false; bot.buffer[action.engine.bIndex].revealedThisTurn = true;
                        room.markModified('players'); await room.save();
                        io.to(roomName).emit('updatePlayers', room); await sleep(1500);
                        if (action.type === 'joker') await finalizeJoker(room, botIndex, action); else await finalizePlay(room, botIndex, action.engine);
                    } else {
                        io.to(roomName).emit('botTaunt', `${bot.name} gissade fel eller kortet passade inte.`);
                        await applyPenalty(room, botIndex);
                    }
                } else {
                    io.to(roomName).emit('botTaunt', msg);
                    await sleep(3000);
                    if (action.type === 'joker') await finalizeJoker(room, botIndex, action); else await finalizePlay(room, botIndex, action.engine);
                }
            } else {
                // PANIK
                let facedowns = bot.buffer.map((c,i) => c.isFacedown ? i : -1).filter(i => i!==-1);
                if (facedowns.length > 0) {
                    let idx = facedowns[Math.floor(Math.random()*facedowns.length)];
                    await executeBotAction(room, botIndex, { type:'play', engine: {card:bot.buffer[idx], bIndex:idx, isFacedown:true} });
                } else if (bot.buffer.length > 0) {
                    io.to(roomName).emit('botTaunt', `${bot.name} är låst och tar ett straff.`);
                    await sleep(3000); await applyPenalty(room, botIndex);
                }
            }
        } catch (err) { console.error("FATAL AI ERROR:", err); }
    }

    async function finalizePlay(room, botIndex, eng) {
        let b = room.players[botIndex]; room.cardsPlayedCount++;
        room.boardState[eng.card.suit][eng.side] = eng.card.value;
        if (room.cardsPlayedCount <= 3) room.boardState[eng.card.suit]['joker' + eng.side.charAt(0).toUpperCase() + eng.side.slice(1)] = true;
        room.lastAction = { type: 'play', playerName: b.name, card: eng.card, side: eng.side }; room.lastActionTime = Date.now();
        let wasFacedown = b.buffer[eng.bIndex].revealedThisTurn;
        b.replaceIndex = eng.bIndex; b.buffer.splice(eng.bIndex, 1);
        room.markModified('players'); room.markModified('boardState'); await room.save();
        io.to(room.roomName).emit('boardUpdated', room); io.to(room.roomName).emit('updatePlayers', room); // FIX: Dubbel-sync
        if (b.hand.length > 0) { b.mustReplace = true; b.replaceFacedown = wasFacedown; await room.save(); await sleep(2000); return playBotTurn(room.roomName, botIndex); }
        await sleep(3000); return nextTurn(room);
    }

    async function finalizeJoker(room, botIndex, action) {
        let f = action.jFrom; let t = action.jTo;
        room.boardState[f.suit]['joker' + f.side.charAt(0).toUpperCase() + f.side.slice(1)] = false;
        room.boardState[t.suit]['joker' + t.side.charAt(0).toUpperCase() + t.side.slice(1)] = true;
        room.lastAction = { type: 'joker', playerName: room.players[botIndex].name, suit: t.suit, side: t.side }; room.lastActionTime = Date.now();
        room.markModified('boardState'); await room.save();
        io.to(room.roomName).emit('boardUpdated', room); io.to(room.roomName).emit('updatePlayers', room);
        await sleep(3000); return nextTurn(room);
    }

    async function applyPenalty(room, botIndex) {
        let b = room.players[botIndex];
        let faceups = b.buffer.map((c,i) => !c.isFacedown ? i : -1).filter(i => i!==-1);
        if (faceups.length > 0) { b.buffer[faceups[0]].isFacedown = true; room.markModified('players'); await room.save(); io.to(room.roomName).emit('updatePlayers', room); await sleep(3000); return nextTurn(room); }
        else { room.gamePhase = 'gameover'; await room.save(); io.to(room.roomName).emit('gameEnded', { msg: "Bot lost the game." }); }
    }

    async function handlePlayerLeave(socketId, specificRoom = null, explicitPlayerId = null) {
        let room = await Room.findOne({ roomName: specificRoom });
        if (!room) return;
        let pId = explicitPlayerId || Array.from(io.sockets.sockets.values()).find(s => s.id === socketId)?.playerId;
        if (!pId) return;
        let idx = room.players.findIndex(p => p.id === pId);
        if (idx !== -1) {
            if (room.gamePhase !== 'waiting' && room.gamePhase !== 'gameover') {
                io.to(room.roomName).emit('playerLeft', { msg: `${room.players[idx].name} left.` });
                await Room.deleteOne({ roomName: room.roomName });
            } else {
                room.players.splice(idx, 1);
                if (room.players.length === 0) await Room.deleteOne({ roomName: room.roomName });
                else { if (room.hostId === pId) room.hostId = room.players[0].id; room.markModified('players'); await room.save(); io.to(room.roomName).emit('roomUpdate', room); }
            }
        }
    }

    socket.on('leaveGame', (data) => handlePlayerLeave(socket.id, data.roomName, data.playerId));
    socket.on('disconnect', () => {});
});

setInterval(async () => {
    const expire = Date.now() - (72 * 60 * 60 * 1000);
    try { await Room.deleteMany({ lastUpdated: { $lt: expire } }); } catch (err) {}
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));