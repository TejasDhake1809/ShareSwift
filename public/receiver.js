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
  let totalFiles = 0, totalBytes = 0;

  const startTimeMap = new Map();
  const lastReceivedMap = new Map();

  const ACK_EVERY_N_CHUNKS = 16; // batch ack every 16 chunks
  let ackCounter = 0;

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

    const iceServers = await fetch("/ice-servers").then(res => res.json()).catch(() => [{ urls: "stun:stun.l.google.com:19302" }]);

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

  function handleDataMessage(e) {
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data);
      if (msg.type === 'header') startNextFile(msg.meta);
      else if (msg.type === 'done') finishCurrentFile();
    } else {
      if (!currentFile) return;
      currentFile.buffer.push(e.data);
      currentFile.received += e.data.byteLength;

      const now = performance.now();
      const last = lastReceivedMap.get(currentFile.meta.filename) || { lastTime: now, lastBytes: 0 };
      const instantSpeed = ((currentFile.received - last.lastBytes) / 1024 / 1024) / ((now - last.lastTime) / 1000); // MB/s
      lastReceivedMap.set(currentFile.meta.filename, { lastTime: now, lastBytes: currentFile.received });

      if (!currentFile.row.lastUpdate || now - currentFile.row.lastUpdate > 100) { // throttle DOM
        updateProgress();
        currentFile.row.lastUpdate = now;
      }

      ackCounter++;
      if (ackCounter >= ACK_EVERY_N_CHUNKS && dataChannel.readyState === "open") {
        dataChannel.send("ack");
        ackCounter = 0;
      }

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
      startTimeMap.set(meta.filename, performance.now());
      lastReceivedMap.set(meta.filename, { lastTime: performance.now(), lastBytes: 0 });
    } else fileQueue.push(fileObj);

    showToast(`Receiving file: ${meta.filename}`, 'info');
  }

  function updateProgress() {
    if (!currentFile || !currentFile.row) return;
    currentFile.row.querySelector('.progress-bar-fill').style.width =
      `${Math.floor((currentFile.received / currentFile.meta.size) * 100)}%`;
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
    const endTime = performance.now();
    const duration = (endTime - startTimeMap.get(currentFile.meta.filename)) / 1000;
    const avgSpeed = (currentFile.meta.size / 1024 / 1024 / duration).toFixed(2);
    console.log(`File ${currentFile.meta.filename} received in ${duration.toFixed(2)}s | Avg Speed: ${avgSpeed} MB/s`);

    totalFiles++;
    totalBytes += currentFile.meta.size;
    receivedMetrics.textContent = `Files received: ${totalFiles} | Total bytes: ${totalBytes}`;

    currentFile = fileQueue.shift() || null;
    if (currentFile) {
      startTimeMap.set(currentFile.meta.filename, performance.now());
      lastReceivedMap.set(currentFile.meta.filename, { lastTime: performance.now(), lastBytes: 0 });
    }
  }

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
    totalFiles = 0;
    totalBytes = 0;
    startTimeMap.clear();
    lastReceivedMap.clear();
  });
});
