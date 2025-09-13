const { io } = require("socket.io-client");

// --- Configuration ---
const SERVER_URL = "https://shareswift-1.onrender.com"; 
const NUM_CLIENTS = 10;
// MODIFIED: Significantly increased the delay to prevent server overload
const JOIN_DELAY_MS = 250; // Before: 25. This gives the server time to process each client.
const CLIENT_TIMEOUT_MS = 30000; // 30 seconds per client
const SERVER_WARMUP_DELAY_MS = 10000; // 10 seconds (still good practice)

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

  let hasFinished = false; // Flag to prevent double-counting errors/successes

  // Add a timeout for each client. If it doesn't finish in time, count it as a failure.
  const clientTimeout = setTimeout(() => {
    if (hasFinished) return;
    hasFinished = true;
    failedConnections++;
    console.error(`❌ A client timed out after ${CLIENT_TIMEOUT_MS / 1000}s.`);
    socket.disconnect(); // This triggers the 'disconnect' event, which calls checkCompletion()
  }, CLIENT_TIMEOUT_MS);

  socket.on("connect", () => {
    socket.emit("receiver-join", { roomId });
  });

  socket.on("offer", ({ from }) => {
    socket.emit("answer", { to: from, answer: { type: "dummy-answer" } });
  });

  socket.on("ice-candidate", ({ from }) => {
    if (hasFinished) return; 
    successfulHandshakes++;
    console.log(`🤝 Handshake #${successfulHandshakes} complete.`);
    socket.emit("test-ready-for-transfer", { to: from });
  });

  if (SIMULATE_FILE_TRANSFER) {
    socket.on("test-transfer-done", () => {
        if (hasFinished) return;
        successfulTransfers++;
        console.log(`✅ Transfer #${successfulTransfers} complete for client.`);
        socket.disconnect();
    });
  } else {
      socket.on("ice-candidate", () => {
          if (!hasFinished) socket.disconnect();
      });
  }

  socket.on("connect_error", (err) => {
    if (hasFinished) return;
    hasFinished = true;
    failedConnections++;
    console.error(`❌ Client connection failed: ${err.message}`);
    clearTimeout(clientTimeout);
    checkCompletion();
  });

  socket.on("no-sender", ({ message }) => {
    if (hasFinished) return;
    hasFinished = true;
    failedConnections++;
    console.error(`❌ Client failed to join: ${message}`);
    clearTimeout(clientTimeout);
    checkCompletion();
  });

  socket.on("disconnect", () => {
    if (hasFinished) return;
    hasFinished = true;
    clientsDone++;
    clearTimeout(clientTimeout); 
    checkCompletion();
  });
};

// Main test orchestrator
const runTest = async () => {
  console.log("Phase 1: Creating a room with a single sender...");
  
  const senderSocket = io(SERVER_URL, { transports: ["websocket"] });

  const getRoomId = new Promise((resolve, reject) => {
    senderSocket.on("connect", () => senderSocket.emit("create-room"));
    senderSocket.on("room-created", ({ roomId }) => {
      console.log(`🏠 Room created with ID: ${roomId}\n`);
      resolve(roomId);
    });
    senderSocket.on("connect_error", reject);
  });

  try {
    const roomId = await getRoomId;
    
    // MODIFIED: Wait for the server to warm up before launching receivers
    console.log(`Server is waking up... waiting ${SERVER_WARMUP_DELAY_MS / 1000} seconds.`);
    await new Promise(resolve => setTimeout(resolve, SERVER_WARMUP_DELAY_MS));
    
    if (SIMULATE_FILE_TRANSFER) {
      senderSocket.on("test-ready-for-transfer", ({ from }) => {
        console.log(`\n🚀 Starting simulated file transfer to client ${from}...`);
        for (let i = 0; i < SIMULATED_CHUNK_COUNT; i++) {
          senderSocket.emit("test-simulated-chunk", { to: from, payload: `chunk-${i}` }); 
        }
        senderSocket.emit("test-transfer-done", { to: from });
      });
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

runTest();

