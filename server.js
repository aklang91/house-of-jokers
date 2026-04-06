const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

function createDeck() {
    const suits = ['♠', '♥', '♣', '♦']; 
    const deck = [];
    suits.forEach(suit => {
        for (let value = 1; value <= 13; value++) {
            deck.push({ suit, value });
        }
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

const rooms = {};

io.on('connection', (socket) => {
    console.log('A player connected:', socket.id);
    
    socket.emit('yourId', socket.id);

    socket.on('createGame', (data, callback) => {
        const { playerName, roomName, maxPlayers } = data;
        
        if (rooms[roomName]) {
            return callback({ success: false, msg: "A room with that name already exists!" });
        }

        rooms[roomName] = {
            roomName: roomName,
            maxPlayers: parseInt(maxPlayers),
            players: [{ id: socket.id, name: playerName, hand: [], buffer: [], mustReplace: false, replaceFacedown: false }],
            boardState: {
                '♠': { min: 7, max: 7, jokerMin: false, jokerMax: false, jokerCenter: false },
                '♥': { min: 7, max: 7, jokerMin: false, jokerMax: false, jokerCenter: false },
                '♦': { min: 7, max: 7, jokerMin: false, jokerMax: false, jokerCenter: false },
                '♣': { min: 7, max: 7, jokerMin: false, jokerMax: false, jokerCenter: false }
            },
            cardsPlayedCount: 0,
            currentTurn: -1, // Ingen har turen under setup
            gamePhase: 'waiting' 
        };

        socket.join(roomName);
        callback({ success: true });
        io.to(roomName).emit('roomUpdate', rooms[roomName]);
    });

    socket.on('joinGame', (data, callback) => {
        const { playerName, roomName } = data;
        const room = rooms[roomName];

        if (!room) return callback({ success: false, msg: "The room doesn't exist!" });
        if (room.gamePhase !== 'waiting') return callback({ success: false, msg: "The game has already started!" });
        if (room.players.length >= room.maxPlayers) return callback({ success: false, msg: "The room is full!" });

        room.players.push({ id: socket.id, name: playerName, hand: [], buffer: [], mustReplace: false, replaceFacedown: false });
        socket.join(roomName);
        callback({ success: true });

        if (room.players.length === room.maxPlayers) {
            startGame(roomName);
        } else {
            io.to(roomName).emit('roomUpdate', room);
        }
    });

    function startGame(roomName) {
        let room = rooms[roomName];
        room.gamePhase = 'setup';
        room.currentTurn = -1; // Parallel setup
        
        let deck = shuffle(createDeck()).filter(card => card.value !== 7); 
        
        let pIndex = 0;
        while(deck.length > 0) {
            room.players[pIndex].hand.push(deck.pop());
            pIndex = (pIndex + 1) % room.players.length;
        }

        const suitOrder = { '♠': 1, '♥': 2, '♣': 3, '♦': 4 };
        room.players.forEach(p => {
            p.hand.sort((a, b) => {
                if (suitOrder[a.suit] !== suitOrder[b.suit]) {
                    return suitOrder[a.suit] - suitOrder[b.suit];
                }
                return a.value - b.value;
            });
        });

        io.to(roomName).emit('gameState', room);
    }

    socket.on('fillBuffer', (data, callback) => {
        const { roomName, pIndex, cardIndex } = data;
        let room = rooms[roomName];
        if(!room) return;
        let player = room.players[pIndex];
        
        if (player.id !== socket.id) return callback({ success: false, msg: "That is not you!" });

        // Ersätt ett spelat kort under spelets gång
        if (player.mustReplace) {
            let card = player.hand.splice(cardIndex, 1)[0];
            card.isFacedown = player.replaceFacedown; 
            player.buffer.push(card);
            
            player.mustReplace = false;
            nextTurn(roomName);
            callback({ success: true });

        // Välja kort i startfasen (Sker parallellt)
        } else if (room.gamePhase === 'setup' && player.buffer.length < 3) {
            let card = player.hand.splice(cardIndex, 1)[0];
            card.isFacedown = true; 
            player.buffer.push(card);
            
            // Kolla om alla spelare har valt sina tre kort
            if (room.players.every(p => p.buffer.length === 3)) {
                room.gamePhase = 'playing';
                room.players.forEach(p => p.buffer.forEach(c => c.isFacedown = false));

                // Beräkna vem som börjar
                let maxHandSize = Math.max(...room.players.map(p => p.hand.length));
                let candidates = room.players.map((p, i) => p.hand.length === maxHandSize ? i : -1).filter(i => i !== -1);
                room.currentTurn = candidates[Math.floor(Math.random() * candidates.length)];
            }
            io.to(roomName).emit('updatePlayers', room);
            callback({ success: true });
        } else {
            callback({ success: false, msg: "You cannot select more cards right now!" });
        }
    });

    socket.on('flipCard', (data) => {
        let room = rooms[data.roomName];
        if(!room) return;
        if(room.players[data.pIndex] && room.players[data.pIndex].id === socket.id) {
            room.players[data.pIndex].buffer[data.bIndex].isFacedown = true;
            nextTurn(data.roomName); 
        }
    });

    socket.on('flipCardAndRevert', (data) => {
        let room = rooms[data.roomName];
        if(!room) return;
        let player = room.players[data.pIndex];
        if (player && player.id === socket.id) {
            if (player.buffer[data.penaltyIndex]) player.buffer[data.penaltyIndex].isFacedown = true;
            if (player.buffer[data.revertIndex]) {
                player.buffer[data.revertIndex].isFacedown = true;
                player.buffer[data.revertIndex].revealedThisTurn = false;
            }
            nextTurn(data.roomName);
        }
    });

    socket.on('revealCard', (data) => {
        let room = rooms[data.roomName];
        if(!room) return;
        if(room.players[data.pIndex] && room.players[data.pIndex].id === socket.id) {
            room.players[data.pIndex].buffer[data.bIndex].isFacedown = false;
            room.players[data.pIndex].buffer[data.bIndex].revealedThisTurn = true; 
            io.to(data.roomName).emit('updatePlayers', room);
        }
    });

    socket.on('passTurn', (data) => {
        nextTurn(data.roomName);
    });

    socket.on('gameOver', (data) => {
        let room = rooms[data.roomName];
        if(!room) return;
        room.gamePhase = 'gameover';
        io.to(data.roomName).emit('gameEnded', { msg: data.msg });
    });

    socket.on('leaveGame', (data) => {
        handlePlayerLeave(socket.id, data.roomName);
    });

    socket.on('playCard', (data, callback) => {
        const { roomName, pIndex, bIndex, card, toSuit, toSide } = data;
        let room = rooms[roomName];
        if(!room) return;

        if (room.players[pIndex].id !== socket.id) return callback({success: false, msg: "Cheating!"});
        if (room.gamePhase === 'setup') return callback({ success: false, msg: "Wait until everyone has chosen their playable cards!" });
        if (card.suit !== toSuit) return callback({ success: false, msg: "Card dragged to the wrong suit!" });

        let suitState = room.boardState[card.suit];
        let isValidMove = false;

        if (toSide === 'max' && card.value === suitState.max + 1) {
            if (suitState.jokerMax) return callback({ success: false, msg: "Blocked! A joker is in the way." });
            suitState.max = card.value;
            isValidMove = true;
        } else if (toSide === 'min' && card.value === suitState.min - 1) {
            if (suitState.jokerMin) return callback({ success: false, msg: "Blocked! A joker is in the way." });
            suitState.min = card.value;
            isValidMove = true;
        }

        if (isValidMove) {
            room.cardsPlayedCount++;
            if (room.cardsPlayedCount <= 3) {
                if (toSide === 'max') suitState.jokerMax = true;
                if (toSide === 'min') suitState.jokerMin = true;
            }

            let cardInBuff = room.players[pIndex].buffer[bIndex];
            let playedCardWasFacedown = cardInBuff.isFacedown || cardInBuff.revealedThisTurn;
            
            room.players[pIndex].buffer.splice(bIndex, 1);

            // Vinstcheck
            let isWin = Object.values(room.boardState).every(s => s.min === 1 && s.max === 13);
            if (isWin) {
                room.gamePhase = 'gameover';
                io.to(roomName).emit('boardUpdated', room);
                io.to(roomName).emit('gameWon', { msg: "Congratulations, you won the game together!" });
                return callback({ success: true });
            }

            // Kontrollera om spelaren har kort kvar på handen för att tvinga fram påfyllnad
            if (room.players[pIndex].hand.length > 0) {
                room.players[pIndex].mustReplace = true;
                room.players[pIndex].replaceFacedown = playedCardWasFacedown;
                
                io.to(roomName).emit('boardUpdated', room);
                io.to(roomName).emit('updatePlayers', room);
                callback({ success: true });
            } else {
                // Skicka turen vidare direkt om spelaren inte har några fler kort i handen att fylla på med
                nextTurn(roomName);
                callback({ success: true });
            }
        } else {
            callback({ success: false, msg: "Invalid move! The card doesn't fit there." }); 
        }
    });

    socket.on('moveJoker', (data, callback) => {
        const { roomName, fromSuit, fromSide, toSuit, toSide } = data;
        let room = rooms[roomName];
        if(!room) return;

        if (toSide === 'min' && room.boardState[toSuit].min === 1) return callback({ success: false, msg: "That side is completed and closed!" });
        if (toSide === 'max' && room.boardState[toSuit].max === 13) return callback({ success: false, msg: "That side is completed and closed!" });

        if (toSide === 'center') {
            if (room.boardState[toSuit].min !== 1 || room.boardState[toSuit].max !== 13) {
                return callback({ success: false, msg: "The suit is not fully complete yet!" });
            }
        }

        if (fromSide === 'min') room.boardState[fromSuit].jokerMin = false;
        if (fromSide === 'max') room.boardState[fromSuit].jokerMax = false;
        
        if (toSide === 'min') room.boardState[toSuit].jokerMin = true;
        if (toSide === 'max') room.boardState[toSuit].jokerMax = true;
        if (toSide === 'center') room.boardState[toSuit].jokerCenter = true;

        nextTurn(roomName);
        callback({ success: true });
    });

    function nextTurn(roomName) {
        let room = rooms[roomName];
        if(!room) return;

        // Nollställ eventuella temporärt visade kort
        room.players.forEach(p => p.buffer.forEach(c => c.revealedThisTurn = false));
        
        let startIndex = room.currentTurn;
        let nextIndex = (startIndex + 1) % room.players.length;
        
        // Loopa för att hitta nästa spelare som inte är helt färdig (har kort på hand ELLER i buffer)
        while (nextIndex !== startIndex) {
            let p = room.players[nextIndex];
            if (p.hand.length > 0 || p.buffer.length > 0) {
                break; // Vi hittade en aktiv spelare, avbryt sökningen
            }
            nextIndex = (nextIndex + 1) % room.players.length;
        }
        
        room.currentTurn = nextIndex;
        
        io.to(roomName).emit('boardUpdated', room);
        io.to(roomName).emit('updatePlayers', room);
    }

    function handlePlayerLeave(socketId, specificRoom = null) {
        let roomsToCheck = specificRoom ? [specificRoom] : Object.keys(rooms);
        
        for (let roomName of roomsToCheck) {
            let room = rooms[roomName];
            if (!room) continue;

            let playerIndex = room.players.findIndex(p => p.id === socketId);
            if (playerIndex !== -1) {
                let player = room.players[playerIndex];
                
                if (room.gamePhase !== 'waiting' && room.gamePhase !== 'gameover') {
                    room.gamePhase = 'gameover';
                    io.to(roomName).emit('playerLeft', { msg: `${player.name} chose to leave. You have lost.` });
                }
                
                if (room.gamePhase === 'waiting') {
                    room.players.splice(playerIndex, 1);
                    io.to(roomName).emit('roomUpdate', room);
                    if (room.players.length === 0) delete rooms[roomName]; 
                } else {
                    delete rooms[roomName];
                }
            }
        }
    }

    socket.on('disconnect', () => {
        handlePlayerLeave(socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`House of Jokers running on port ${PORT}`);
});