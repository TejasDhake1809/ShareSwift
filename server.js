const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get("/ice-servers", async (req, res) => {
  try {
    const iceServers = await getTwilioIceServers();
    res.json(iceServers);
  } catch (err) {
    console.error("Error in /ice-servers:", err.message);
    res.status(500).json([{ urls: "stun:stun.l.google.com:19302" }]);
  }
});

// Map roomId -> { sender: socketId, receivers: Set<socketId>, iceServerCache: Array | null }
const rooms = new Map();

// Helper: fetch Twilio ICE servers
async function getTwilioIceServers() {
  // This function is now only called once per room, not once per user.
  try {
    const response = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Tokens.json`,
      {},
      {
        auth: {
          username: process.env.TWILIO_ACCOUNT_SID,
          password: process.env.TWILIO_AUTH_TOKEN,
        },
      }
    );
    return response.data.ice_servers;
  } catch (err) {
    console.error('Failed to fetch Twilio ICE servers:', err.message);
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
}

io.on('connection', socket => {
  console.log('Socket connected:', socket.id);

  // Sender creates a room, initializing the ICE server cache to null
  socket.on('create-room', () => {
    const roomId = uuidv4().slice(0, 6);
    // ✅ MODIFIED: Initialize room with a null cache for ICE servers
    rooms.set(roomId, { sender: socket.id, receivers: new Set(), iceServerCache: null });
    socket.join(roomId);
    console.log(`Room created: ${roomId} by ${socket.id}`);
    socket.emit('room-created', { roomId });
  });

  // Receiver joins a room
  socket.on('receiver-join', async ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) {
      return socket.emit('no-sender', { message: 'No sender for that Room ID' });
    }

    room.receivers.add(socket.id);
    socket.join(roomId);

    // ✅ MODIFIED: Caching logic for ICE servers
    let iceServers;
    if (room.iceServerCache) {
      // If cache exists, use it instantly. No API call.
      console.log(`Using cached ICE servers for room ${roomId}`);
      iceServers = room.iceServerCache;
    } else {
      // If cache is empty, fetch from Twilio ONCE and store the result.
      console.log(`Fetching NEW ICE servers for room ${roomId}`);
      iceServers = await getTwilioIceServers();
      room.iceServerCache = iceServers; // Store in cache for next user
    }
    
    // Send the retrieved (or cached) ICE servers to the clients
    socket.emit('ice-config', { iceServers });
    io.to(room.sender).emit('ice-config', { iceServers });
    
    // Notify sender and initialize connection
    io.to(room.sender).emit('update-receivers', { count: room.receivers.size });
    io.to(room.sender).emit('init', { receiverSocketId: socket.id });

    console.log(`Receiver ${socket.id} joined room ${roomId}`);
  });

  // --- All other event handlers remain the same ---

  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('receiver-disconnect', () => {
    rooms.forEach((room, roomId) => {
      if (room.receivers.has(socket.id)) {
        room.receivers.delete(socket.id);
        io.to(room.sender).emit('receiver-disconnect', { receiverId: socket.id });
        io.to(room.sender).emit('update-receivers', { count: room.receivers.size });
        console.log('Receiver manually disconnected:', socket.id);
      }
    });
  });

  // Handlers for the test script
  socket.on('test-ready-for-transfer', ({ to }) => {
    io.to(to).emit('test-ready-for-transfer', { from: socket.id });
  });
  socket.on('test-simulated-chunk', ({ to, payload }) => {
    io.to(to).emit('test-simulated-chunk', { from: socket.id, payload });
  });
  socket.on('test-transfer-done', ({ to }) => {
    io.to(to).emit('test-transfer-done', { from: socket.id });
  });

  // Disconnect logic
  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
    rooms.forEach((room, roomId) => {
      if (room.sender === socket.id) {
        room.receivers.forEach(rid => io.to(rid).emit('sender-disconnected'));
        rooms.delete(roomId);
      } else if (room.receivers.has(socket.id)) {
        room.receivers.delete(socket.id);
        io.to(room.sender).emit('receiver-disconnect', { receiverId: socket.id });
        io.to(room.sender).emit('update-receivers', { count: room.receivers.size });
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

