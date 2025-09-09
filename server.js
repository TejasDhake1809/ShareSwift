// server.js
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Map roomId -> senderSocketId
const senders = new Map();

io.on('connection', socket => {
  console.log('Socket connected:', socket.id);

  // Sender creates a room
  socket.on('create-room', () => {
    const roomId = uuidv4().slice(0, 6); // short 6-char ID
    senders.set(roomId, socket.id);
    socket.join(roomId);
    console.log(`Room created: ${roomId} by ${socket.id}`);
    socket.emit('room-created', { roomId });
  });

  // Receiver joins a room
  socket.on('receiver-join', ({ roomId }) => {
    const senderSocketId = senders.get(roomId);
    if (senderSocketId) {
      socket.join(roomId);
      io.to(senderSocketId).emit('init', { receiverSocketId: socket.id });
    } else {
      socket.emit('no-sender', { message: 'No sender for that Room ID' });
    }
  });

  // Relay offer/answer
  socket.on('offer', ({ to, offer }) => io.to(to).emit('offer', { from: socket.id, offer }));
  socket.on('answer', ({ to, answer }) => io.to(to).emit('answer', { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
    for (const [roomId, sid] of senders.entries()) {
      if (sid === socket.id) senders.delete(roomId);
    }
  });
});

server.listen(3000, () => console.log('Server running on port 3000'));
