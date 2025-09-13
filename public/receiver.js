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

  let pc = null, dataChannel = null;
  let totalFiles = 0, totalBytes = 0;
  const filesInProgress = new Map();
  const pendingChunks = new Map();

  function log(msg) { console.log(`[Receiver] ${msg}`); }
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
        log("Data channel open");
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

  // ---------------- DATA HANDLING ----------------
  function handleDataMessage(e) {
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data);
      log(`Received message type: ${msg.type} for fileId: ${msg.fileId || 'N/A'}`);

      if (msg.type === 'header') startFile(msg.fileId, msg.meta);
      else if (msg.type === 'done') {
        const fileObj = filesInProgress.get(msg.fileId);
        if (fileObj) {
          fileObj.doneReceived = true;
          if (fileObj.received >= fileObj.meta.size) finishFile(msg.fileId);
          else log(`Done received but waiting for remaining chunks for ${msg.fileId}`);
        } else {
          log(`Done received for unknown fileId ${msg.fileId}, storing temporarily`);
          if (!pendingChunks.has(msg.fileId)) pendingChunks.set(msg.fileId, []);
          pendingChunks.get(msg.fileId).push({ done: true });
        }
      }
    } else {
      const { fileId, chunk } = parseChunk(e.data);
      let fileObj = filesInProgress.get(fileId);

      if (!fileObj) {
        log(`Received chunk for unknown fileId ${fileId}, storing temporarily`);
        if (!pendingChunks.has(fileId)) pendingChunks.set(fileId, []);
        pendingChunks.get(fileId).push(chunk);
        return;
      }

      fileObj.buffer.push(chunk);
      fileObj.received += chunk.byteLength;
      updateProgress(fileObj);

      if (fileObj.doneReceived && fileObj.received >= fileObj.meta.size) finishFile(fileId);
    }
  }

  function parseChunk(data) {
    const dataView = new DataView(data);
    const fileIdLength = dataView.getUint8(0);
    const decoder = new TextDecoder();
    const fileId = decoder.decode(data.slice(1, 1 + fileIdLength));
    const chunk = data.slice(1 + fileIdLength);
    return { fileId, chunk };
  }

  function startFile(fileId, meta) {
    const row = document.createElement('div');
    row.className = 'file-entry';
    row.innerHTML = `<div class="fname">${meta.filename}</div><div class="progress-bar"><div class="progress-bar-fill"></div></div>`;
    receivedFiles.appendChild(row);

    const fileObj = { meta, buffer: [], received: 0, row, doneReceived: false };
    filesInProgress.set(fileId, fileObj);
    log(`Started file ${meta.filename} (ID: ${fileId})`);

    if (pendingChunks.has(fileId)) {
      pendingChunks.get(fileId).forEach(chunk => {
        if (chunk.done) {
          fileObj.doneReceived = true;
          if (fileObj.received >= fileObj.meta.size) finishFile(fileId);
        } else handleDataMessage({ data: prependFileId(fileId, chunk) });
      });
      pendingChunks.delete(fileId);
      log(`Processed pending chunks for ${meta.filename}`);
    }
  }

  function prependFileId(fileId, chunk) {
    const encoder = new TextEncoder();
    const idBytes = encoder.encode(fileId);
    const buffer = new Uint8Array(1 + idBytes.length + chunk.byteLength);
    buffer[0] = idBytes.length;
    buffer.set(idBytes, 1);
    buffer.set(new Uint8Array(chunk), 1 + idBytes.length);
    return buffer.buffer;
  }

  function updateProgress(fileObj) {
    const percent = Math.min(100, (fileObj.received / fileObj.meta.size) * 100);
    fileObj.row.querySelector('.progress-bar-fill').style.width = `${percent.toFixed(2)}%`;
    log(`Progress: ${percent.toFixed(2)}% for ${fileObj.meta.filename}`);
  }

  function finishFile(fileId) {
    if (!filesInProgress.has(fileId)) return;
    const fileObj = filesInProgress.get(fileId);
    const blob = new Blob(fileObj.buffer, { type: "application/octet-stream" });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileObj.meta.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    fileObj.row.querySelector('.progress-bar-fill').style.width = '100%';
    totalFiles++;
    totalBytes += fileObj.meta.size;
    receivedMetrics.textContent = `Files received: ${totalFiles} | Total bytes: ${totalBytes}`;
    showToast(`File received: ${fileObj.meta.filename}`, 'success');
    log(`Finished file ${fileObj.meta.filename} (ID: ${fileId})`);
    filesInProgress.delete(fileId);
  }

  // ---------------- UI ----------------
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

    log("Disconnected");
    dataChannel = null;
    pc = null;
    filesInProgress.clear();
    pendingChunks.clear();
    totalFiles = 0;
    totalBytes = 0;
  });
});
