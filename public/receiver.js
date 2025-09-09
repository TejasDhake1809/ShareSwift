document.addEventListener('DOMContentLoaded', () => {
  const socket = io({ transports: ['websocket'] });

  const joinInput = document.getElementById('join-room-input');
  const joinBtn = document.getElementById('join-room-btn');
  const joinStatus = document.getElementById('join-status');
  const receivePanel = document.getElementById('receive-panel');
  const receivedFiles = document.getElementById('received-files');
  const roomDisplay = document.getElementById('room-display');
  const receivedMetrics = document.getElementById('received-metrics');

  let pc = null;
  let dataChannel = null;
  let incoming = { buffer: [], meta: null, received: 0, row: null };
  const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  let totalFiles = 0;
  let totalBytes = 0;

  // Join room button
  joinBtn.addEventListener('click', () => {
    const roomId = joinInput.value.trim();
    if (!roomId) {
      joinStatus.textContent = 'Enter Room ID';
      joinStatus.className = 'error';
      return;
    }
    joinStatus.textContent = 'Joining...';
    joinStatus.className = 'connecting';
    socket.emit('receiver-join', { roomId });
  });

  // No sender found
  socket.on('no-sender', ({ message }) => {
    joinStatus.textContent = message;
    joinStatus.className = 'error';
  });

  // Receive offer
  socket.on('offer', async ({ from, offer }) => {
    const roomId = joinInput.value.trim();
    roomDisplay.textContent = roomId;
    joinStatus.textContent = 'Connected';
    joinStatus.className = 'connected';

    pc = new RTCPeerConnection(rtcConfig);

    pc.onicecandidate = event => {
      if (event.candidate) socket.emit('ice-candidate', { to: from, candidate: event.candidate });
    };

    pc.ondatachannel = event => {
      dataChannel = event.channel;
      dataChannel.binaryType = 'arraybuffer';
      dataChannel.onopen = () => receivePanel.classList.remove('hidden');
      dataChannel.onmessage = handleDataMessage;

      // Handle disconnects
      dataChannel.onclose = () => {
        joinStatus.textContent = 'Disconnected';
        joinStatus.className = 'disconnected';
      };
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

  // Handle incoming data
  function handleDataMessage(e) {
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data);
      if (msg.type === 'header') initIncomingFile(msg.meta);
      else if (msg.type === 'done') finishIncomingFile();
    } else {
      incoming.buffer.push(e.data);
      incoming.received += e.data.byteLength;
      updateProgress();
      if (incoming.received >= incoming.meta.size) finishIncomingFile();
    }
  }

  function initIncomingFile(meta) {
    incoming.meta = meta;
    incoming.buffer = [];
    incoming.received = 0;

    const row = document.createElement('div');
    row.className = 'file-entry';
    row.innerHTML = `
      <div class="fname">${meta.filename}</div>
      <div class="progress-bar"><div class="progress-bar-fill"></div></div>
    `;
    receivedFiles.appendChild(row);
    incoming.row = row;
  }

  function updateProgress() {
    if (!incoming.row) return;
    const pct = Math.floor((incoming.received / incoming.meta.size) * 100);
    const fill = incoming.row.querySelector('.progress-bar-fill');
    fill.style.width = pct + '%';
  }

  function finishIncomingFile() {
    if (!incoming.meta) return;

    const blob = new Blob(incoming.buffer, { type: incoming.meta.type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = incoming.meta.filename;
    a.click();

    updateProgress();
    incoming.row.querySelector('.progress-bar-fill').style.width = '100%';

    totalFiles += 1;
    totalBytes += incoming.meta.size;
    receivedMetrics.textContent = `Files received: ${totalFiles} | Total bytes: ${totalBytes}`;

    incoming = { buffer: [], meta: null, received: 0, row: null };
  }

  // Click-to-copy room ID
  roomDisplay.addEventListener('click', () => {
    if (!roomDisplay.textContent) return;
    navigator.clipboard.writeText(roomDisplay.textContent)
      .then(() => alert(`Room ID ${roomDisplay.textContent} copied to clipboard!`))
      .catch(err => console.error('Failed to copy room ID', err));
  });
});
