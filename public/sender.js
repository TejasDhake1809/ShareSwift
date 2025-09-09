document.addEventListener('DOMContentLoaded', () => {
  const socket = io({ transports: ['websocket'] });

  const createRoomBtn = document.getElementById('create-room-btn');
  const sharePanel = document.getElementById('share-panel');
  const roomDisplay = document.getElementById('room-display-persistent');
  const peerStatus = document.getElementById('peer-status');
  const fileMetrics = document.getElementById('file-metrics');
  const fileInput = document.getElementById('file-input');
  const sendBtn = document.getElementById('send-btn');
  const cancelBtn = document.getElementById('cancel-btn');

  let pc = null;
  let dataChannel = null;
  let files = [];
  let totalSize = 0;
  let receiverId = null;

  function showToast(msg, type = "info") {
    let bg = type === "error" ? "#e74c3c" : type === "success" ? "#2ecc71" : "#3498db";
    Toastify({ text: msg, duration: 2000, gravity: "top", position: "right", style: { background: bg } }).showToast();
  }

  // Create Room
  createRoomBtn.addEventListener('click', () => socket.emit('create-room'));

  socket.on('room-created', ({ roomId }) => {
    roomDisplay.textContent = roomId;
    sharePanel.classList.remove('hidden');
    showToast(`Room ${roomId} created`, "success");
  });

  // Init receiver connection
  socket.on('init', async ({ receiverSocketId }) => {
    receiverId = receiverSocketId;
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

    dataChannel = pc.createDataChannel("files");
    dataChannel.binaryType = "arraybuffer";

    dataChannel.onopen = () => showToast("Data channel open", "success");
    dataChannel.onmessage = e => console.log("Received from peer:", e.data);

    pc.onicecandidate = event => {
      if (event.candidate && receiverId) socket.emit('ice-candidate', { to: receiverId, candidate: event.candidate });
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: receiverId, offer: pc.localDescription });
  });

  socket.on('answer', async ({ answer }) => {
    if (!pc) return;
    await pc.setRemoteDescription(answer);
    showToast("Receiver connected", "success");
  });

  socket.on('ice-candidate', async ({ candidate }) => {
    if (pc && candidate) await pc.addIceCandidate(candidate).catch(err => console.warn(err));
  });

  // File selection
  fileInput.addEventListener('change', () => {
    files = Array.from(fileInput.files);
    totalSize = files.reduce((acc, f) => acc + f.size, 0);
    fileMetrics.textContent = `Files Selected: ${files.length} | Total Size: ${totalSize} B`;
    sendBtn.disabled = files.length === 0;
    cancelBtn.disabled = files.length === 0;
    showToast(`${files.length} file(s) selected`);
  });

  // Send files
  sendBtn.addEventListener('click', () => {
    if (!dataChannel || !files.length) return;

    files.forEach(file => {
      const meta = { filename: file.name, size: file.size, type: file.type };
      dataChannel.send(JSON.stringify({ type: "header", meta }));

      const chunkSize = 16384;
      let offset = 0;
      const reader = new FileReader();

      reader.onload = e => {
        dataChannel.send(e.target.result);
        offset += e.target.result.byteLength;
        if (offset < file.size) readSlice(offset);
        else dataChannel.send(JSON.stringify({ type: "done" }));
      };

      function readSlice(o) {
        const slice = file.slice(o, o + chunkSize);
        reader.readAsArrayBuffer(slice);
      }

      readSlice(0);
    });

    files = [];
    fileMetrics.textContent = `Files Selected: 0 | Total Size: 0 B`;
    fileInput.value = '';
    sendBtn.disabled = true;
    cancelBtn.disabled = true;
    showToast("Files sent", "success");
  });

  // Cancel selection
  cancelBtn.addEventListener('click', () => {
    files = [];
    totalSize = 0;
    fileMetrics.textContent = `Files Selected: 0 | Total Size: 0 B`;
    fileInput.value = '';
    sendBtn.disabled = true;
    cancelBtn.disabled = true;
    showToast("File selection canceled", "error");
  });

  // Copy room ID
  roomDisplay.addEventListener('click', () => {
    if (!roomDisplay.textContent) return;
    navigator.clipboard.writeText(roomDisplay.textContent).then(() => showToast("Room ID copied!", "success"));
  });
});
