const { io } = require("socket.io-client");

// --- Configuration ---
const SERVER_URL = "https://shareswift-1.onrender.com"; 
const NUM_CLIENTS = 100;
const JOIN_DELAY_MS = 25; 

// --- File Transfer Simulation ---
const SIMULATE_FILE_TRANSFER = true;
const SIMULATED_CHUNK_COUNT = 256; // 256 chunks * 64KB = 16MB simulated file
// ---------------------

let successfulHandshakes = 0;
let successfulTransfers = 0;
let failedConnections = 0;
let clientsDone = 0;

console.log(`--- Starting Concurrent Load Test ---`);
console.log(`Server: ${SERVER_URL}`);
console.log(`Simulating: 1 Sender, ${NUM_CLIENTS} Receivers`);
if (SIMULATE_FILE_TRANSFER) {
  console.log(`File Transfer Simulation: ENABLED (${SIMULATED_CHUNK_COUNT} chunks per client)`);
}
console.log(`-------------------------------------\n`);

// This function simulates a single receiver client.
const createReceiver = (roomId) => {
  const socket = io(SERVER_URL, {
    transports: ["websocket"],
    reconnection: false, 
  });

  let handshakeComplete = false;

  socket.on("connect", () => {
    socket.emit("receiver-join", { roomId });
  });

  // The receiver simulates the handshake
  socket.on("offer", ({ from }) => {
    socket.emit("answer", { to: from, answer: { type: "dummy-answer" } });
  });

  socket.on("ice-candidate", ({ from }) => {
    if (handshakeComplete) return; 
    handshakeComplete = true;
    successfulHandshakes++;
    console.log(`🤝 Handshake #${successfulHandshakes} complete.`);
    
    // Tell the sender we're ready for the next step.
    socket.emit("test-ready-for-transfer", { to: from });
  });

  // If file transfer is enabled, listen for the 'done' message on our custom event
  if (SIMULATE_FILE_TRANSFER) {
    socket.on("test-transfer-done", () => {
        successfulTransfers++;
        console.log(`✅ Transfer #${successfulTransfers} complete for client.`);
        setTimeout(() => socket.disconnect(), 200); // Disconnect after success
    });
  }

  socket.on("connect_error", (err) => {
    failedConnections++;
    console.error(`❌ Client connection failed: ${err.message}`);
    checkCompletion();
  });

  socket.on("no-sender", ({ message }) => {
    failedConnections++;
    console.error(`❌ Client failed to join: ${message}`);
    checkCompletion();
  });

  socket.on("disconnect", () => {
    clientsDone++;
    checkCompletion();
  });
};

// Main test orchestrator
const runTest = async () => {
  console.log("Phase 1: Creating a room with a single sender...");
  
  const senderSocket = io(SERVER_URL, { transports: ["websocket"] });

  const getRoomId = new Promise((resolve, reject) => {
    senderSocket.on("connect", () => {
      senderSocket.emit("create-room");
    });
    senderSocket.on("room-created", ({ roomId }) => {
      console.log(`🏠 Room created with ID: ${roomId}\n`);
      resolve(roomId);
    });
    senderSocket.on("connect_error", reject);
  });

  try {
    const roomId = await getRoomId;
    
    // The sender listens for a receiver to be ready for the transfer simulation
    if (SIMULATE_FILE_TRANSFER) {
      senderSocket.on("test-ready-for-transfer", ({ from }) => {
        console.log(`\n🚀 Starting simulated file transfer to client ${from}...`);
        
        // This simulates the data transfer. In the real app, these are chunks.
        // Here, we're just testing if the server can handle the message volume.
        for (let i = 0; i < SIMULATED_CHUNK_COUNT; i++) {
          // We use a dedicated event for clarity and to avoid conflicts.
          senderSocket.emit("test-simulated-chunk", { to: from, payload: `chunk-${i}` }); 
        }

        // After sending all chunks, send the 'done' message.
        senderSocket.emit("test-transfer-done", { to: from });
      });

      // Your server needs to relay these new custom events.
      // Make sure your server.js has listeners for 'test-simulated-chunk' and 'test-transfer-done'
      // and relays them using io.to(to).emit(...)
    }
    
    console.log(`Phase 2: Launching ${NUM_CLIENTS} receivers...\n`);
    for (let i = 0; i < NUM_CLIENTS; i++) {
      setTimeout(() => createReceiver(roomId), i * JOIN_DELAY_MS);
    }

  } catch (error) {
    console.error("❌ Critical Error: Could not create room with sender.", error.message);
    process.exit(1);
  }
};

// Function to check if all clients are done and print final report
function checkCompletion() {
  if (clientsDone + failedConnections >= NUM_CLIENTS) {
    console.log(`\n--- Test Complete ---`);
    console.log(`Successful Handshakes: ${successfulHandshakes} / ${NUM_CLIENTS}`);
    if (SIMULATE_FILE_TRANSFER) {
      console.log(`Successful Transfers:  ${successfulTransfers} / ${NUM_CLIENTS}`);
    }
    console.log(`Failed Connections:    ${failedConnections}`);
    console.log(`---------------------\n`);
    process.exit(0);
  }
}

// Start the test
runTest();