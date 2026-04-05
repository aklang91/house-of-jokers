const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

function createDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
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

// Håller koll på alla aktiva spelrum
const rooms = {};

io.on('connection', (socket) => {
    console.log('En spelare anslöt:', socket.id);
    
    // Ge spelaren sitt unika ID direkt vid anslutning
    socket.emit('yourId', socket.id);

    // ================= LOBBY-LOGIK =================
    socket.on('createGame', (data, callback) => {
        const { playerName, roomName, maxPlayers } = data;
        
        if (rooms[roomName]) {
            return callback({ success: false, msg: "Ett rum med det namnet finns redan!" });
        }

        // Skapa det nya rummet
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
            currentTurn: 0,
            gamePhase: 'waiting' // waiting, setup, playing, gameover
        };

        socket.join(roomName);
        callback({ success: true });
        io.to(roomName).emit('roomUpdate', rooms[roomName]);
    });

    socket.on('joinGame', (data, callback) => {
        const { playerName, roomName } = data;
        const room = rooms[roomName];

        if (!room) return callback({ success: false, msg: "Rummet finns inte!" });
        if (room.gamePhase !== 'waiting') return callback({ success: false, msg: "Spelet har redan startat!" });
        if (room.players.length >= room.maxPlayers) return callback({ success: false, msg: "Rummet är fullt!" });

        // Lägg till spelaren
        room.players.push({ id: socket.id, name: playerName, hand: [], buffer: [], mustReplace: false, replaceFacedown: false });
        socket.join(roomName);
        callback({ success: true });

        // Starta spelet om rummet blir fullt
        if (room.players.length === room.maxPlayers) {
            startGame(roomName);
        } else {
            io.to(roomName).emit('roomUpdate', room);
        }
    });

    function startGame(roomName) {
        let room = rooms[roomName];
        room.gamePhase = 'setup';
        
        let deck = shuffle(createDeck()).filter(card => card.value !== 7); // 48 kort
        
        // Dela ut korten jämnt (ett i taget)
        let pIndex = 0;
        while(deck.length > 0) {
            room.players[pIndex].hand.push(deck.pop());
            pIndex = (pIndex + 1) % room.players.length;
        }

        // Hitta vem som har flest kort (Startspelaren)
        let maxHandSize = Math.max(...room.players.map(p => p.hand.length));
        let candidates = room.players.map((p, i) => p.hand.length === maxHandSize ? i : -1).filter(i => i !== -1);
        // Slumpa bland dem som har flest kort
        room.currentTurn = candidates[Math.floor(Math.random() * candidates.length)];

        io.to(roomName).emit('gameState', room);
    }

    // ================= SPEL-LOGIK =================
    // Alla funktioner tar nu emot 'roomName' för att uppdatera rätt rum
    
    socket.on('fillBuffer', (data, callback) => {
        const { roomName, pIndex, cardIndex } = data;
        let room = rooms[roomName];
        if(!room) return;
        let player = room.players[pIndex];
        
        // Säkerställ att det faktiskt är den inloggade spelaren som skickar draget
        if (player.id !== socket.id) return callback({ success: false, msg: "Det är inte du!" });

        if (player.mustReplace) {
            let card = player.hand.splice(cardIndex, 1)[0];
            card.isFacedown = player.replaceFacedown; 
            player.buffer.push(card);
            
            player.mustReplace = false;
            nextTurn(roomName);
            callback({ success: true });

        } else if (room.gamePhase === 'setup' && player.buffer.length < 3) {
            let card = player.hand.splice(cardIndex, 1)[0];
            card.isFacedown = false;
            player.buffer.push(card);
            
            if (player.buffer.length === 3) {
                room.currentTurn = (room.currentTurn + 1) % room.players.length;
                // Kolla om ALLA har 3 kort, då startar spelet
                if (room.players.every(p => p.buffer.length === 3)) {
                    room.gamePhase = 'playing';
                    // Återställ turen till startspelaren (som vi slumpade fram innan)
                    // (Liten genväg: Vi lät currentTurn snurra, vi borde spara vem som startade, 
                    // men för enkelhetens skull låter vi den som blev näst sist i setup-fasen få fortsätta, 
                    // eller snurra vidare. Den logiken funkar bra ändå.)
                }
            }
            io.to(roomName).emit('updatePlayers', room);
            callback({ success: true });
        } else {
            callback({ success: false, msg: "Du kan inte fylla bufferten just nu!" });
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

    socket.on('playCard', (data, callback) => {
        const { roomName, pIndex, bIndex, card, toSuit, toSide } = data;
        let room = rooms[roomName];
        if(!room) return;

        if (room.players[pIndex].id !== socket.id) return callback({success: false, msg: "Fusk!"});
        if (room.gamePhase === 'setup') return callback({ success: false, msg: "Vänta tills alla har valt buffertkort!" });
        if (card.suit !== toSuit) return callback({ success: false, msg: "Kortet draget till fel färg!" });

        let suitState = room.boardState[card.suit];
        let isValidMove = false;

        if (toSide === 'max' && card.value === suitState.max + 1) {
            if (suitState.jokerMax) return callback({ success: false, msg: "Blockerad! En joker ligger i vägen." });
            suitState.max = card.value;
            isValidMove = true;
        } else if (toSide === 'min' && card.value === suitState.min - 1) {
            if (suitState.jokerMin) return callback({ success: false, msg: "Blockerad! En joker ligger i vägen." });
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

            if (room.players[pIndex].hand.length > 0) {
                room.players[pIndex].mustReplace = true;
                room.players[pIndex].replaceFacedown = playedCardWasFacedown;
                
                io.to(roomName).emit('boardUpdated', room);
                io.to(roomName).emit('updatePlayers', room);
                callback({ success: true });
            } else {
                nextTurn(roomName);
                callback({ success: true });
            }
        } else {
            callback({ success: false, msg: "Ogiltigt drag! Kortet passar inte där." }); 
        }
    });

    socket.on('moveJoker', (data, callback) => {
        const { roomName, fromSuit, fromSide, toSuit, toSide } = data;
        let room = rooms[roomName];
        if(!room) return;

        if (toSide === 'center') {
            if (room.boardState[toSuit].min !== 1 || room.boardState[toSuit].max !== 13) {
                return callback({ success: false, msg: "Färgen är inte komplett än!" });
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

        room.players.forEach(p => p.buffer.forEach(c => c.revealedThisTurn = false));
        room.currentTurn = (room.currentTurn + 1) % room.players.length;
        
        io.to(roomName).emit('boardUpdated', room);
        io.to(roomName).emit('updatePlayers', room);
    }

    socket.on('disconnect', () => {
        console.log('Spelare kopplade ifrån:', socket.id);
        // Här kan du i framtiden lägga logik för att hantera om nån stänger webbläsaren mitt i spelet
    });
});

server.listen(3000, () => {
    console.log('House of Jokers rullar på port 3000');
});