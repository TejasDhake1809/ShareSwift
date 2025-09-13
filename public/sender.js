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
  const selectedFilesList = document.getElementById('selected-files-list');

  const receivers = new Map(); // receiverId -> { pc, dataChannel }
  let filesQueue = [];
  let totalSentFiles = 0;
  let totalSentBytes = 0;
  let isSending = false;

  function log(msg) { console.log(`[Sender] ${msg}`); }
  function showToast(msg, type = "info") {
    const bg = type === "error" ? "#e74c3c" : type === "success" ? "#2ecc71" : "#3498db";
    Toastify({ text: msg, duration: 2000, gravity: "top", position: "right", style: { background: bg } }).showToast();
  }

  createRoomBtn.addEventListener('click', () => socket.emit('create-room'));

  socket.on('room-created', ({ roomId }) => {
    roomDisplay.textContent = roomId;
    sharePanel.classList.remove('hidden');
    showToast(`Room ${roomId} created`, "success");
  });

  socket.on('init', async ({ receiverSocketId }) => {
    const iceServers = await fetch("/ice-servers").then(res => res.json()).catch(() => [{ urls: "stun:stun.l.google.com:19302" }]);
    const pc = new RTCPeerConnection({ iceServers });
    const dataChannel = pc.createDataChannel("files", { ordered: true });
    dataChannel.binaryType = "arraybuffer";
    receivers.set(receiverSocketId, { pc, dataChannel });

    dataChannel.onopen = () => log(`Data channel open for receiver ${receiverSocketId}`);
    dataChannel.onmessage = e => log(`Received from ${receiverSocketId}: ${e.data}`);

    pc.onicecandidate = event => {
      if (event.candidate) socket.emit('ice-candidate', { to: receiverSocketId, candidate: event.candidate });
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: receiverSocketId, offer: pc.localDescription });
  });

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

  // ---------------- FILE SELECTION ----------------
  fileInput.addEventListener('change', () => {
    const selectedFiles = Array.from(fileInput.files);
    filesQueue.push(...selectedFiles);
    const totalSize = filesQueue.reduce((acc, f) => acc + f.size, 0);
    fileMetrics.textContent = `Files Selected: ${filesQueue.length} | Total Size: ${totalSize} B`;
    sendBtn.disabled = filesQueue.length === 0;
    cancelBtn.disabled = filesQueue.length === 0;

    selectedFilesList.innerHTML = '';
    filesQueue.forEach(f => {
      const div = document.createElement('div');
      div.className = 'selected-file';
      div.textContent = f.name;
      selectedFilesList.appendChild(div);
    });

    fileInput.value = '';
    showToast(`${selectedFiles.length} file(s) added to queue`);
  });

  sendBtn.addEventListener('click', async () => {
    if (!receivers.size || !filesQueue.length || isSending) return;
    isSending = true;
    while (filesQueue.length) await sendFile(filesQueue.shift());
    isSending = false;
    selectedFilesList.innerHTML = '';
    fileMetrics.textContent = `Files Selected: 0 | Total Size: 0 B`;
    sendBtn.disabled = true;
    cancelBtn.disabled = true;
    showToast("All files sent!", "success");
  });

  // ---------------- SEND FILE WITH CHUNK ACK ----------------
  async function sendFile(file) {
    return new Promise(resolve => {
      const meta = { filename: file.name, size: file.size, type: file.type };
      const fileId = crypto.randomUUID();
      log(`Sending file ${file.name} (ID: ${fileId})`);

      const row = document.createElement('div');
      row.className = 'file-entry';
      row.innerHTML = `<div class="fname">${meta.filename}</div><div class="progress-bar"><div class="progress-bar-fill"></div></div>`;
      filesList.appendChild(row);

      // Send header
      receivers.forEach(({ dataChannel }) => dataChannel.send(JSON.stringify({ type: "header", fileId, meta })));

      const chunkSize = 16384;
      const totalChunks = Math.ceil(file.size / chunkSize);
      let chunkIndex = 0;

      const reader = new FileReader();

      // ACK listener
      function onAck(e) {
        const msg = JSON.parse(e.data);
        if (msg.type === 'ack' && msg.fileId === fileId && msg.chunkIndex === chunkIndex - 1) {
          sendNextChunk();
        }
      }

      receivers.forEach(({ dataChannel }) => dataChannel.addEventListener('message', onAck));

      function sendNextChunk() {
        if (chunkIndex >= totalChunks) {
          receivers.forEach(({ dataChannel }) => dataChannel.send(JSON.stringify({ type: 'done', fileId })));
          receivers.forEach(({ dataChannel }) => dataChannel.removeEventListener('message', onAck));
          totalSentFiles++;
          totalSentBytes += file.size;
          sentMetrics.textContent = `Files Sent: ${totalSentFiles} | Total Bytes: ${totalSentBytes}`;
          resolve();
          return;
        }

        const start = chunkIndex * chunkSize;
        const end = Math.min(file.size, start + chunkSize);
        reader.readAsArrayBuffer(file.slice(start, end));
      }

      reader.onload = e => {
        const chunkData = e.target.result;
        const msg = { type: "chunk", fileId, chunkIndex, chunk: chunkData };
        receivers.forEach(({ dataChannel }) => dataChannel.send(JSON.stringify(msg)));
        row.querySelector('.progress-bar-fill').style.width = `${Math.floor(((chunkIndex + 1) / totalChunks) * 100)}%`;
        chunkIndex++;
      };

      sendNextChunk();
    });
  }

  cancelBtn.addEventListener('click', () => {
    filesQueue = [];
    selectedFilesList.innerHTML = '';
    fileMetrics.textContent = `Files Selected: 0 | Total Size: 0 B`;
    sendBtn.disabled = true;
    cancelBtn.disabled = true;
    showToast("File selection canceled", "error");
  });

  roomDisplay.addEventListener('click', () => {
    if (!roomDisplay.textContent) return;
    navigator.clipboard.writeText(roomDisplay.textContent).then(() => showToast("Room ID copied!", "success"));
  });
});
