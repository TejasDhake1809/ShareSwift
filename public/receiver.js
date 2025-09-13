document.addEventListener('DOMContentLoaded', () => {
  const socket = io({ transports: ['websocket'] });

  const joinInput = document.getElementById('join-room-input');
  const joinBtn = document.getElementById('join-room-btn');
  const joinStatus = document.getElementById('join-status');
  const joinPanel = document.getElementById('join-panel');
  const receivePanel = document.getElementById('receive-panel');
  const receivedFiles = document.getElementById('received-files');
  const roomDisplay = document.getElementById('room-display');
  const receivedMetrics = document.getElementById('received-metrics');
  const disconnectBtn = document.getElementById('disconnect-btn');

  let pc = null;
  let dataChannel = null;
  let fileQueue = [];
  let currentFile = null;
  let pendingChunks = []; // NEW: store chunks arriving before header
  let totalFiles = 0, totalBytes = 0;

  function showToast(msg, type = "info") {
    const bg = type === "error" ? "#e74c3c" : type === "success" ? "#2ecc71" : "#3498db";
    Toastify({ text: msg, duration: 2000, gravity: "top", position: "right", style: { background: bg } }).showToast();
  }

  joinBtn.addEventListener('click', () => {
    const roomId = joinInput.value.trim();
    if (!roomId) return showToast('Enter Room ID', 'error');
    joinStatus.textContent = 'Joining...';
    socket.emit('receiver-join', { roomId });
  });

  socket.on('no-sender', ({ message }) => {
    joinStatus.textContent = message;
    showToast(message, 'error');
  });

  socket.on('offer', async ({ from, offer }) => {
    const roomId = joinInput.value.trim();
    roomDisplay.textContent = roomId;
    joinStatus.textContent = 'Connected';
    showToast(`Connected to room ${roomId}`, 'success');

    const iceServers = await fetch("/ice-servers")
      .then(res => res.json())
      .catch(() => [{ urls: "stun:stun.l.google.com:19302" }]);

    pc = new RTCPeerConnection({ iceServers });

    pc.onicecandidate = e => {
      if (e.candidate) socket.emit('ice-candidate', { to: from, candidate: e.candidate });
    };

    pc.ondatachannel = e => {
      dataChannel = e.channel;
      dataChannel.binaryType = 'arraybuffer';
      dataChannel.onopen = () => {
        receivePanel.classList.remove('hidden');
        joinPanel.classList.add('hidden');
        showToast("Ready to receive files!", "success");
      };
      dataChannel.onmessage = handleDataMessage;
    };

    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: from, answer: pc.localDescription });
  });

  socket.on('ice-candidate', async ({ candidate }) => {
    if (!pc || !candidate) return;
    try { await pc.addIceCandidate(candidate); } catch (err) { console.warn(err); }
  });

  // ------------------- DATA HANDLING -------------------
  function handleDataMessage(e) {
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data);
      if (msg.type === 'header') startNextFile(msg.meta);
      else if (msg.type === 'done') finishCurrentFile();
    } else {
      if (!currentFile) {
        pendingChunks.push(e.data); // queue until header arrives
        return;
      }
      currentFile.buffer.push(e.data);
      currentFile.received += e.data.byteLength;
      updateProgress();
      if (currentFile.received >= currentFile.meta.size) finishCurrentFile();
    }
  }

  function startNextFile(meta) {
    const row = document.createElement('div');
    row.className = 'file-entry';
    row.innerHTML = `<div class="fname">${meta.filename}</div><div class="progress-bar"><div class="progress-bar-fill"></div></div>`;
    receivedFiles.appendChild(row);

    const fileObj = { meta, buffer: [], received: 0, row };

    if (!currentFile) {
      currentFile = fileObj;
      // flush pending chunks
      pendingChunks.forEach(chunk => {
        currentFile.buffer.push(chunk);
        currentFile.received += chunk.byteLength;
      });
      pendingChunks = [];
      updateProgress();
    } else {
      fileQueue.push(fileObj);
    }

    showToast(`Receiving file: ${meta.filename}`, 'info');
  }

  function updateProgress() {
    if (!currentFile || !currentFile.row) return;
    const percent = Math.min(100, (currentFile.received / currentFile.meta.size) * 100);
    currentFile.row.querySelector('.progress-bar-fill').style.width = `${percent}%`;
  }

  function finishCurrentFile() {
    if (!currentFile) return;
    const blob = new Blob(currentFile.buffer, { type: "application/octet-stream" });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = currentFile.meta.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    currentFile.row.querySelector('.progress-bar-fill').style.width = '100%';

    totalFiles++;
    totalBytes += currentFile.meta.size;
    receivedMetrics.textContent = `Files received: ${totalFiles} | Total bytes: ${totalBytes}`;
    showToast(`File received: ${currentFile.meta.filename}`, 'success');

    currentFile = fileQueue.shift() || null;
    // flush pending chunks for the next file
    if (currentFile && pendingChunks.length) {
      pendingChunks.forEach(chunk => {
        currentFile.buffer.push(chunk);
        currentFile.received += chunk.byteLength;
      });
      pendingChunks = [];
      updateProgress();
    }
  }

  // ------------------- UI -------------------
  roomDisplay.addEventListener('click', () => {
    if (!roomDisplay.textContent) return;
    navigator.clipboard.writeText(roomDisplay.textContent).then(() => showToast('Room ID copied!', 'success'));
  });

  disconnectBtn.addEventListener('click', () => {
    if (dataChannel) dataChannel.close();
    if (pc) pc.close();
    socket.emit('receiver-disconnect');

    receivePanel.classList.add('hidden');
    joinPanel.classList.remove('hidden');
    joinStatus.textContent = '';
    receivedFiles.innerHTML = '';
    receivedMetrics.textContent = `Files received: 0 | Total bytes: 0`;
    roomDisplay.textContent = '';

    showToast("Disconnected from room", "info");

    dataChannel = null;
    pc = null;
    currentFile = null;
    fileQueue = [];
    pendingChunks = [];
    totalFiles = 0;
    totalBytes = 0;
  });
});
