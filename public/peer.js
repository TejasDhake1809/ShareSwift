const socket = io();
let pc;
let dataChannel;

const fileInput = document.getElementById("file-input");
const roomInput = document.getElementById("room-id-input");
const roomDisplay = document.getElementById("room-display");
const joinBtn = document.getElementById("join-room-btn");
const receivedDiv = document.getElementById("received-files");

function joinRoom(roomID) {
  if (!roomID) roomID = Math.floor(Math.random() * 1000000).toString();
  roomDisplay && (roomDisplay.innerText = "Room ID: " + roomID);
  socket.emit("join-room", roomID);
  return roomID;
}

// Sender
if (fileInput) {
  const roomID = joinRoom(roomInput.value.trim());

  socket.on("new-receiver", peerID => {
    pc = new RTCPeerConnection();
    dataChannel = pc.createDataChannel("fileChannel");

    setupDataChannel();

    pc.onicecandidate = e => {
      if (e.candidate) socket.emit("signal", { to: peerID, signal: e.candidate });
    };

    pc.createOffer().then(offer => pc.setLocalDescription(offer))
      .then(() => socket.emit("signal", { to: peerID, signal: pc.localDescription }));
  });

  fileInput.onchange = e => {
    if (!dataChannel || dataChannel.readyState !== "open") return;
    const file = e.target.files[0];
    if (!file) return;

    const chunkSize = 16 * 1024;
    let offset = 0;
    const reader = new FileReader();

    reader.onload = () => {
      const buffer = new Uint8Array(reader.result);
      function sendChunk() {
        const slice = buffer.slice(offset, offset + chunkSize);
        dataChannel.send(slice);
        offset += chunkSize;
        if (offset < buffer.length) setTimeout(sendChunk, 0);
      }
      // Send filename header first
      dataChannel.send(JSON.stringify({ filename: file.name, size: file.size }));
      sendChunk();
    };
    reader.readAsArrayBuffer(file);
  };
}

// Receiver
if (joinBtn) {
  joinBtn.onclick = () => {
    const roomID = joinRoom(roomInput.value.trim());
    pc = new RTCPeerConnection();

    pc.ondatachannel = e => {
      dataChannel = e.channel;
      setupDataChannel();
    };

    pc.onicecandidate = e => {
      if (e.candidate) socket.emit("signal", { to: null, signal: e.candidate });
    };
  };
}

socket.on("signal", async ({ from, signal }) => {
  if (!pc) pc = new RTCPeerConnection();

  if (signal.type === "offer") {
    await pc.setRemoteDescription(new RTCSessionDescription(signal));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("signal", { to: from, signal: pc.localDescription });
  } else if (signal.type === "answer") {
    await pc.setRemoteDescription(new RTCSessionDescription(signal));
  } else if (signal.candidate) {
    await pc.addIceCandidate(new RTCIceCandidate(signal));
  }
});

function setupDataChannel() {
  let incomingFile = { buffer: [], filename: "", size: 0, received: 0 };

  dataChannel.onopen = () => console.log("Data channel open");
  dataChannel.onmessage = e => {
    if (typeof e.data === "string") {
      const msg = JSON.parse(e.data);
      incomingFile.filename = msg.filename;
      incomingFile.size = msg.size;
    } else {
      incomingFile.buffer.push(e.data);
      incomingFile.received += e.data.byteLength;

      if (incomingFile.received >= incomingFile.size) {
        const blob = new Blob(incomingFile.buffer);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = incomingFile.filename;
        a.click();
        incomingFile = { buffer: [], filename: "", size: 0, received: 0 };
      }
    }
  };
}
