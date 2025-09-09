// server.js
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // default CORS OK when serving static pages from same server
});

app.use(express.static(path.join(__dirname, 'public')));

// Map roomId -> senderSocketId
const senders = new Map();

io.on('connection', socket => {
  console.log('Socket connected:', socket.id);

  socket.on('sender-join', ({ roomId }) => {
    console.log('sender-join', roomId, socket.id);
    senders.set(roomId, socket.id);
    socket.join(roomId);
  });

  socket.on('receiver-join', ({ roomId }) => {
    console.log('receiver-join', roomId, socket.id);
    const senderSocketId = senders.get(roomId);
    if (senderSocketId) {
      // notify sender that a receiver connected (give receiver socket id)
      io.to(senderSocketId).emit('init', { receiverSocketId: socket.id });
      // and join the room (optional)
      socket.join(roomId);
    } else {
      socket.emit('no-sender', { message: 'No sender for that Room ID' });
    }
  });

  // Relay offer/answer by destination socket id
  socket.on('offer', ({ to, offer }) => {
    if (!to || !offer) return;
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    if (!to || !answer) return;
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    if (!to || !candidate) return;
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
    // remove any room mapping owned by this sender
    for (const [roomId, sid] of senders.entries()) {
      if (sid === socket.id) senders.delete(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Signaling server running at http://localhost:${PORT}`));
