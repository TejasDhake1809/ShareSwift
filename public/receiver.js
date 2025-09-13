// receiver.js (Updated with StreamSaver.js)

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
  let currentFile = null;
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
      .catch(err => {
        console.error("Failed to fetch ICE servers:", err);
        return [{ urls: "stun:stun.l.google.com:19302" }];
      });

    pc = new RTCPeerConnection({ iceServers });

    pc.onicecandidate = e => {
      if (e.candidate) socket.emit('ice-candidate', { to: from, candidate: e.candidate });
    };

    pc.oniceconnectionstatechange = () => console.log('ICE state:', pc.iceConnectionState);
    pc.onconnectionstatechange = () => console.log('Connection state:', pc.connectionState);

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
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn(err);
    }
  });

  function handleDataMessage(e) {
    // String data is for metadata (header, done)
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data);
      if (msg.type === 'header') {
        startNextFile(msg.meta);
      } else if (msg.type === 'done') {
        finishCurrentFile();
      }
      return;
    }

    // Binary data is a file chunk
    if (!currentFile || !currentFile.writer) return;

    // ✅ KEY CHANGE: Write the chunk directly to the file stream
    currentFile.writer.write(new Uint8Array(e.data));

    currentFile.received += e.data.byteLength;
    updateProgress();
  }

  function startNextFile(meta) {
    const row = document.createElement('div');
    row.className = 'file-entry';
    row.innerHTML = `<div class="fname">${meta.filename}</div><div class="progress-bar"><div class="progress-bar-fill"></div></div>`;
    receivedFiles.appendChild(row);

    // ✅ KEY CHANGE: Create a writable stream using StreamSaver.js
    const fileStream = streamSaver.createWriteStream(meta.filename, {
      size: meta.size
    });

    currentFile = {
      meta,
      received: 0,
      row,
      writer: fileStream.getWriter() // Get the writer to push data to the file
    };

    showToast(`Receiving file: ${meta.filename}`, 'info');
  }

  function updateProgress() {
    if (!currentFile || !currentFile.row) return;
    const progress = Math.floor((currentFile.received / currentFile.meta.size) * 100);
    currentFile.row.querySelector('.progress-bar-fill').style.width = `${progress}%`;
  }

  function finishCurrentFile() {
    if (!currentFile || !currentFile.writer) return;

    // ✅ KEY CHANGE: Close the writer to finalize the file download
    currentFile.writer.close();

    currentFile.row.querySelector('.progress-bar-fill').style.width = '100%';
    totalFiles++;
    totalBytes += currentFile.meta.size;
    receivedMetrics.textContent = `Files received: ${totalFiles} | Total bytes: ${totalBytes}`;
    showToast(`File received: ${currentFile.meta.filename}`, 'success');

    currentFile = null; // Ready for the next file
  }

  // ... (keep the rest of the event listeners like disconnectBtn, etc., they are unchanged)
  disconnectBtn.addEventListener('click', () => {
    if (dataChannel) dataChannel.close();
    if (pc) pc.close();
    if (currentFile && currentFile.writer) {
        currentFile.writer.abort(); // Abort the stream if disconnected mid-file
    }
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
    totalFiles = 0;
    totalBytes = 0;
  });
});