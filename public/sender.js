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
  const uploadSpeedMetrics = document.getElementById('upload-speed-metrics');

  const receivers = new Map();
  let filesQueue = [];
  let totalSentFiles = 0;
  let totalSentBytes = 0;
  let isSending = false;

  // Performance Tuning Constants
  const CHUNK_SIZE = 64 * 1024; // 64 KB
  const ACK_BATCH_SIZE = 256;   // Send 256 chunks (16MB), then wait for ACK

  // Map to hold the 'resolve' functions for pending ACK promises
  const ackResolvers = new Map();

  function showToast(msg, type = "info") {
    const bg = type === "error" ? "#e74c3c" : type === "success" ? "#2ecc71" : "#3498db";
    Toastify({ text: msg, duration: 2000, gravity: "top", position: "right", style: { background: bg } }).showToast();
  }
  
  // Central handler for incoming ACK messages from receivers
  function handleAck(receiverSocketId) {
    if (ackResolvers.has(receiverSocketId)) {
      const resolve = ackResolvers.get(receiverSocketId);
      resolve(); // Resolve the promise the sender is waiting on
      ackResolvers.delete(receiverSocketId);
    }
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
    
    const queue = [];
    receivers.set(receiverSocketId, { pc, dataChannel, queue });

    dataChannel.onopen = () => {
      showToast(`Data channel open for receiver ${receiverSocketId}`, "success");
      while (queue.length) dataChannel.send(queue.shift());
    };
    
    // Set the onmessage handler to route ACKs to our handler
    dataChannel.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'ack') {
        handleAck(receiverSocketId);
      }
    };

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
    fileInput.value = ''; // Clear the input to allow selecting the same file again
    showToast(`${selectedFiles.length} file(s) added to queue`);
  });

  sendBtn.addEventListener('click', async () => {
    if (!receivers.size || !filesQueue.length || isSending) return;
    isSending = true;
    sendBtn.disabled = true;
    cancelBtn.disabled = true;
    while (filesQueue.length) {
      await sendFile(filesQueue.shift());
    }
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
    let lastTimestamp = Date.now();
    let lastOffset = 0;

    while (offset < file.size) {
      // Send a batch of chunks
      for (let i = 0; i < ACK_BATCH_SIZE && offset < file.size; i++) {
        const chunkSlice = file.slice(offset, offset + CHUNK_SIZE);
        const chunkBuffer = await chunkSlice.arrayBuffer();
        receivers.forEach(({ dataChannel }) => {
          if (dataChannel.readyState === 'open') {
            dataChannel.send(chunkBuffer);
          }
        });
        offset += chunkBuffer.byteLength;
      }

      // Wait for an ACK from every connected receiver
      const ackPromises = [];
      for (const [id, { dataChannel }] of receivers.entries()) {
        if (dataChannel.readyState === 'open') {
          const promise = new Promise(resolve => {
            ackResolvers.set(id, resolve);
          });
          ackPromises.push(promise);
        }
      }
      if (ackPromises.length > 0) {
        await Promise.all(ackPromises);
      }
      
      progressBarFill.style.width = `${Math.floor((offset / file.size) * 100)}%`;

      // Calculate and display upload speed
      const now = Date.now();
      const timeDiffInSeconds = (now - lastTimestamp) / 1000;
      if (timeDiffInSeconds >= 1) { // Update roughly every second
          const bytesDiff = offset - lastOffset;
          const speedMbps = (bytesDiff * 8) / timeDiffInSeconds / 1000000;
          uploadSpeedMetrics.textContent = `Speed: ${speedMbps.toFixed(2)} Mbps`;
          lastTimestamp = now;
          lastOffset = offset;
      }
    }

    uploadSpeedMetrics.textContent = 'Speed: 0 Mbps';

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