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

  const receivers = new Map(); // receiverId -> { pc, dataChannel, queue: [] }
  let filesQueue = [];
  let totalSentFiles = 0;
  let totalSentBytes = 0;
  let isSending = false;

  // Constants for file transfer
  const CHUNK_SIZE = 64 * 1024; // 64 KB chunk size
  const HIGH_WATER_MARK = 16 * 1024 * 1024; // Pause sending if buffer is > 16MB

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
    const iceServers = await fetch("/ice-servers")
      .then(res => res.json())
      .catch(err => {
        console.error("Failed to fetch ICE servers:", err);
        return [{ urls: "stun:stun.l.google.com:19302" }];
      });

    const pc = new RTCPeerConnection({ iceServers });
    const dataChannel = pc.createDataChannel("files", { ordered: true });
    dataChannel.binaryType = "arraybuffer";
    
    dataChannel.bufferedAmountLowThreshold = CHUNK_SIZE * 4;

    const queue = [];
    receivers.set(receiverSocketId, { pc, dataChannel, queue });

    dataChannel.onopen = () => {
      showToast(`Data channel open for receiver ${receiverSocketId}`, "success");
      while (queue.length) dataChannel.send(queue.shift());
    };

    dataChannel.onmessage = e => console.log(`Received from ${receiverSocketId}:`, e.data);
    pc.oniceconnectionstatechange = () => console.log(`ICE state for ${receiverSocketId}:`, pc.iceConnectionState);
    pc.onconnectionstatechange = () => console.log(`Connection state for ${receiverSocketId}:`, pc.connectionState);

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

  fileInput.addEventListener('change', () => {
    const selectedFiles = Array.from(fileInput.files);
    filesQueue.push(...selectedFiles);
    const totalSize = filesQueue.reduce((acc, f) => acc + f.size, 0);
    fileMetrics.textContent = `Files Selected: ${filesQueue.length} | Total Size: ${totalSize.toLocaleString()} B`;
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
    sendBtn.disabled = true;
    cancelBtn.disabled = true;
    while (filesQueue.length) await sendFile(filesQueue.shift());
    isSending = false;
    selectedFilesList.innerHTML = '';
    fileMetrics.textContent = `Files Selected: 0 | Total Size: 0 B`;
    showToast("All files sent!", "success");
  });

  async function sendFile(file) {
    const meta = { filename: file.name, size: file.size, type: file.type };
    const row = document.createElement('div');
    row.className = 'file-entry';
    row.innerHTML = `<div class="fname">${meta.filename}</div><div class="progress-bar"><div class="progress-bar-fill"></div></div>`;
    filesList.appendChild(row);

    const progressBarFill = row.querySelector('.progress-bar-fill');

    const header = JSON.stringify({ type: "header", meta });
    receivers.forEach(({ dataChannel, queue }) => {
      if (dataChannel.readyState === 'open') dataChannel.send(header);
      else queue.push(header);
    });

    let offset = 0;
    while (offset < file.size) {
      for (const { dataChannel } of receivers.values()) {
        if (dataChannel.bufferedAmount > HIGH_WATER_MARK) {
          await new Promise(resolve => {
            // ❗ FIX: Use addEventListener with { once: true } for reliability.
            // This prevents a race condition where the event fires before the
            // `onbufferedamountlow` handler is assigned.
            dataChannel.addEventListener('bufferedamountlow', resolve, { once: true });
          });
        }
      }

      const chunkSlice = file.slice(offset, offset + CHUNK_SIZE);
      const chunkBuffer = await chunkSlice.arrayBuffer();

      receivers.forEach(({ dataChannel }) => {
        if (dataChannel.readyState === 'open') {
          dataChannel.send(chunkBuffer);
        }
      });

      offset += chunkBuffer.byteLength;
      progressBarFill.style.width = `${Math.floor((offset / file.size) * 100)}%`;
    }

    const doneMsg = JSON.stringify({ type: 'done' });
    receivers.forEach(({ dataChannel, queue }) => {
      if (dataChannel.readyState === 'open') dataChannel.send(doneMsg);
      else queue.push(doneMsg);
    });
    
    totalSentFiles++;
    totalSentBytes += file.size;
    sentMetrics.textContent = `Files Sent: ${totalSentFiles} | Total Bytes: ${totalSentBytes.toLocaleString()}`;
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