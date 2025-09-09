document.addEventListener('DOMContentLoaded', () => {
  const socket = io({ transports: ['websocket'] });

  const createRoomBtn = document.getElementById('create-room-btn');
  const sharePanel = document.getElementById('share-panel');
  const roomDisplay = document.getElementById('room-display-persistent');
  const peerStatus = document.getElementById('peer-status');
  const fileMetrics = document.getElementById('file-metrics');
  const sentMetrics = document.getElementById('sent-metrics');
  const fileInput = document.getElementById('file-input');
  const sendBtn = document.getElementById('send-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const filesList = document.getElementById('files-list');

  const receivers = new Map(); // Map of receiverId -> { pc, dataChannel }
  let files = [];
  let totalSentFiles = 0;
  let totalSentBytes = 0;

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
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const dataChannel = pc.createDataChannel("files");
    dataChannel.binaryType = "arraybuffer";

    dataChannel.onopen = () => showToast(`Data channel open for receiver ${receiverSocketId}`, "success");
    dataChannel.onmessage = e => console.log(`Received from ${receiverSocketId}:`, e.data);

    pc.onicecandidate = event => {
      if (event.candidate) socket.emit('ice-candidate', { to: receiverSocketId, candidate: event.candidate });
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: receiverSocketId, offer: pc.localDescription });

    receivers.set(receiverSocketId, { pc, dataChannel });
  });

  // Set remote answer for a specific receiver
  socket.on('answer', async ({ from, answer }) => {
    const conn = receivers.get(from);
    if (!conn) return;
    await conn.pc.setRemoteDescription(answer);
    showToast(`Receiver ${from} connected`, "success");
  });

  socket.on('ice-candidate', async ({ candidate, from }) => {
    const conn = receivers.get(from);
    if (!conn || !candidate) return;
    await conn.pc.addIceCandidate(candidate).catch(err => console.warn(err));
  });

  // Handle receiver disconnect
  socket.on('receiver-disconnect', ({ receiverId }) => {
    const conn = receivers.get(receiverId);
    if (!conn) return;

    if (conn.dataChannel) conn.dataChannel.close();
    if (conn.pc) conn.pc.close();

    receivers.delete(receiverId);
    showToast(`Receiver ${receiverId} disconnected`, "error");

    peerStatus.textContent = `Connected peers: ${receivers.size}`;
  });

  socket.on('update-receivers', ({ count }) => {
    peerStatus.textContent = `Connected peers: ${count}`;
  });

  // File selection
  fileInput.addEventListener('change', () => {
    files = Array.from(fileInput.files);
    const totalSize = files.reduce((acc, f) => acc + f.size, 0);
    fileMetrics.textContent = `Files Selected: ${files.length} | Total Size: ${totalSize} B`;
    sendBtn.disabled = files.length === 0;
    cancelBtn.disabled = files.length === 0;
    showToast(`${files.length} file(s) selected`);
  });

  // Send files to all receivers
  sendBtn.addEventListener('click', () => {
    if (!receivers.size || !files.length) return;

    files.forEach(file => {
      const meta = { filename: file.name, size: file.size, type: file.type };

      // UI
      const row = document.createElement('div');
      row.className = 'file-entry';
      row.innerHTML = `
        <div class="fname">${meta.filename}</div>
        <div class="progress-bar"><div class="progress-bar-fill"></div></div>
      `;
      filesList.appendChild(row);

      // Send header to all receivers
      receivers.forEach(({ dataChannel }) => dataChannel.send(JSON.stringify({ type: "header", meta })));

      const chunkSize = 16384;
      let offset = 0;
      const reader = new FileReader();

      reader.onload = e => {
        receivers.forEach(({ dataChannel }) => dataChannel.send(e.target.result));

        offset += e.target.result.byteLength;
        const pct = Math.floor((offset / file.size) * 100);
        row.querySelector('.progress-bar-fill').style.width = pct + '%';

        if (offset < file.size) readSlice(offset);
        else {
          receivers.forEach(({ dataChannel }) => dataChannel.send(JSON.stringify({ type: "done" })));
          totalSentFiles++;
          totalSentBytes += file.size;
          sentMetrics.textContent = `Files Sent: ${totalSentFiles} | Total Bytes: ${totalSentBytes}`;
        }
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
    showToast("Sending files...", "info");
  });

  // Cancel selection
  cancelBtn.addEventListener('click', () => {
    files = [];
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
