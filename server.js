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

let boardState = {};
let cardsPlayedCount = 0;
let players = [];
let currentTurn = 0;
let gamePhase = 'setup'; 

function initGame() {
    boardState = {
        '♠': { min: 7, max: 7, jokerMin: false, jokerMax: false, jokerCenter: false },
        '♥': { min: 7, max: 7, jokerMin: false, jokerMax: false, jokerCenter: false },
        '♦': { min: 7, max: 7, jokerMin: false, jokerMax: false, jokerCenter: false },
        '♣': { min: 7, max: 7, jokerMin: false, jokerMax: false, jokerCenter: false }
    };
    cardsPlayedCount = 0; 
    currentTurn = 0;
    gamePhase = 'setup';

    let deck = shuffle(createDeck());
    deck = deck.filter(card => card.value !== 7); 

    players = [
        { id: 0, name: 'Spelare 1', hand: deck.splice(0, 16), buffer: [], mustReplace: false, replaceFacedown: false },
        { id: 1, name: 'Spelare 2', hand: deck.splice(0, 16), buffer: [], mustReplace: false, replaceFacedown: false },
        { id: 2, name: 'Spelare 3', hand: deck.splice(0, 16), buffer: [], mustReplace: false, replaceFacedown: false }
    ];
}

initGame();

io.on('connection', (socket) => {
    console.log('En spelare anslöt:', socket.id);

    socket.emit('gameState', { boardState, players, currentTurn, gamePhase, cardsPlayedCount });

    socket.on('restart', () => {
        initGame();
        io.emit('gameState', { boardState, players, currentTurn, gamePhase, cardsPlayedCount });
    });

    socket.on('fillBuffer', (data, callback) => {
        const { pIndex, cardIndex } = data;
        let player = players[pIndex];
        
        if (player.mustReplace) {
            let card = player.hand.splice(cardIndex, 1)[0];
            card.isFacedown = player.replaceFacedown; 
            player.buffer.push(card);
            
            player.mustReplace = false;
            nextTurn();
            callback({ success: true });

        } else if (gamePhase === 'setup' && player.buffer.length < 3) {
            let card = player.hand.splice(cardIndex, 1)[0];
            card.isFacedown = false;
            player.buffer.push(card);
            
            if (player.buffer.length === 3) {
                currentTurn++;
                if (currentTurn >= players.length) {
                    currentTurn = 0;
                    gamePhase = 'playing';
                }
            }
            io.emit('updatePlayers', { players, currentTurn, gamePhase, cardsPlayedCount });
            callback({ success: true });
        } else {
            callback({ success: false, msg: "Du kan inte fylla bufferten just nu!" });
        }
    });

    socket.on('flipCard', (data) => {
        const { pIndex, bIndex } = data;
        if(players[pIndex].buffer[bIndex]) {
            players[pIndex].buffer[bIndex].isFacedown = true;
            nextTurn(); 
        }
    });

    socket.on('flipCardAndRevert', (data) => {
        const { pIndex, penaltyIndex, revertIndex } = data;
        let player = players[pIndex];
        if (player && player.buffer[penaltyIndex]) {
            player.buffer[penaltyIndex].isFacedown = true;
        }
        if (player && player.buffer[revertIndex]) {
            player.buffer[revertIndex].isFacedown = true;
            player.buffer[revertIndex].revealedThisTurn = false;
        }
        nextTurn();
    });

    socket.on('revealCard', (data) => {
        if(players[data.pIndex] && players[data.pIndex].buffer[data.bIndex]) {
            players[data.pIndex].buffer[data.bIndex].isFacedown = false;
            players[data.pIndex].buffer[data.bIndex].revealedThisTurn = true; 
            io.emit('updatePlayers', { players, currentTurn, gamePhase, cardsPlayedCount });
        }
    });

    socket.on('passTurn', () => {
        nextTurn();
    });

    socket.on('gameOver', (data) => {
        gamePhase = 'gameover';
        io.emit('gameEnded', { msg: data.msg });
    });

    socket.on('playCard', (data, callback) => {
        const { pIndex, bIndex, card, toSuit, toSide } = data;
        
        if (gamePhase === 'setup') return callback({ success: false, msg: "Vänta tills alla har valt buffertkort!" });
        if (card.suit !== toSuit) return callback({ success: false, msg: "Kortet draget till fel färg!" });

        let suitState = boardState[card.suit];
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
            cardsPlayedCount++;
            if (cardsPlayedCount <= 3) {
                if (toSide === 'max') suitState.jokerMax = true;
                if (toSide === 'min') suitState.jokerMin = true;
            }

            let cardInBuff = players[pIndex].buffer[bIndex];
            let playedCardWasFacedown = cardInBuff.isFacedown || cardInBuff.revealedThisTurn;
            
            players[pIndex].buffer.splice(bIndex, 1);

            if (players[pIndex].hand.length > 0) {
                players[pIndex].mustReplace = true;
                players[pIndex].replaceFacedown = playedCardWasFacedown;
                
                io.emit('boardUpdated', { boardState, cardsPlayedCount });
                io.emit('updatePlayers', { players, currentTurn, gamePhase, cardsPlayedCount });
                callback({ success: true });
            } else {
                nextTurn();
                callback({ success: true });
            }
        } else {
            callback({ success: false, msg: "Ogiltigt drag! Kortet passar inte där." }); 
        }
    });

    socket.on('moveJoker', (data, callback) => {
        const { fromSuit, fromSide, toSuit, toSide } = data;
        
        if (toSide === 'center') {
            if (boardState[toSuit].min !== 1 || boardState[toSuit].max !== 13) {
                return callback({ success: false, msg: "Färgen är inte komplett än!" });
            }
        }

        if (fromSide === 'min') boardState[fromSuit].jokerMin = false;
        if (fromSide === 'max') boardState[fromSuit].jokerMax = false;
        
        if (toSide === 'min') boardState[toSuit].jokerMin = true;
        if (toSide === 'max') boardState[toSuit].jokerMax = true;
        if (toSide === 'center') boardState[toSuit].jokerCenter = true;

        nextTurn();
        callback({ success: true });
    });

    function nextTurn() {
        players.forEach(p => p.buffer.forEach(c => c.revealedThisTurn = false));
        currentTurn = (currentTurn + 1) % 3;
        io.emit('boardUpdated', { boardState, cardsPlayedCount });
        io.emit('updatePlayers', { players, currentTurn, gamePhase, cardsPlayedCount });
    }
});

server.listen(3000, () => {
    console.log('Spelet är igång på port 3000');
});