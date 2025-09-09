document.addEventListener('DOMContentLoaded', () => {
  const socket = io({ transports: ['websocket'] });

  const createBtn = document.getElementById('create-room-btn');
  const persistentRoom = document.getElementById('room-display-persistent');
  const sharePanel = document.getElementById('share-panel');
  const fileInput = document.getElementById('file-input');
  const filesList = document.getElementById('files-list');
  const sendBtn = document.getElementById('send-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const peerStatus = document.getElementById('peer-status');
  const fileMetrics = document.getElementById('file-metrics');

  let roomId = null;
  const peers = new Map(); // receiverSocketId -> { pc, dataChannel }
  let selectedFiles = [];
  let sending = false;
  const chunkSize = 16 * 1024;
  const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  /* --- FILE ROW MAP --- */
  // Map file -> DOM row
  const fileRows = new Map();

  /* --- ROOM & PEER --- */
  createBtn.addEventListener('click', () => {
    roomId = generateRoomId();
    persistentRoom.textContent = roomId;
    socket.emit('sender-join', { roomId });
    sharePanel.classList.remove('hidden');
    updatePeerStatus();
  });

  socket.on('connect', () => console.log('Connected to signaling server:', socket.id));

  persistentRoom.addEventListener('click', () => {
    if (!persistentRoom.textContent) return;
    navigator.clipboard.writeText(persistentRoom.textContent)
      .then(() => alert(`Room ID ${persistentRoom.textContent} copied to clipboard!`))
      .catch(err => console.error('Failed to copy room ID', err));
  });

  socket.on('init', async ({ receiverSocketId: rId }) => {
    const pc = new RTCPeerConnection(rtcConfig);
    const dataChannel = pc.createDataChannel('file');
    dataChannel.binaryType = 'arraybuffer';

    dataChannel.onopen = () => console.log('DataChannel open for', rId);
    dataChannel.onclose = () => {
      console.log('DataChannel closed for', rId);
      peers.delete(rId);
      updatePeerStatus();
    };

    pc.onicecandidate = event => {
      if (event.candidate) socket.emit('ice-candidate', { to: rId, candidate: event.candidate });
    };

    peers.set(rId, { pc, dataChannel });
    updatePeerStatus();

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: rId, offer });
      console.log('Offer sent to receiver', rId);
    } catch (err) { console.error(err); }
  });

  socket.on('answer', async ({ from, answer }) => {
    const peer = peers.get(from);
    if (!peer) return;
    await peer.pc.setRemoteDescription(answer);
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    const peer = peers.get(from);
    if (!peer || !candidate) return;
    try { await peer.pc.addIceCandidate(candidate); } catch (err) { console.warn(err); }
  });

  /* --- FILE SELECTION --- */
  fileInput.addEventListener('change', e => {
    selectedFiles = Array.from(e.target.files);
    sendBtn.disabled = selectedFiles.length === 0 || peers.size === 0;
    cancelBtn.disabled = selectedFiles.length === 0;
    updateFileMetrics();
    renderFileList();
  });

  function updateFileMetrics() {
    const totalSize = selectedFiles.reduce((acc, f) => acc + f.size, 0);
    fileMetrics.textContent = `Files Selected: ${selectedFiles.length} | Total Size: ${formatBytes(totalSize)}`;
  }

  function renderFileList() {
    filesList.innerHTML = '';
    fileRows.clear();
    selectedFiles.forEach(file => {
      const row = document.createElement('div');
      row.className = 'file-entry';
      row.innerHTML = `
        <div class="fname">${file.name}</div>
        <div class="progress-bar"><div class="progress-bar-fill"></div></div>
      `;
      filesList.appendChild(row);
      fileRows.set(file, row);
    });
  }

  /* --- SEND / CANCEL --- */
  sendBtn.addEventListener('click', () => {
    if (selectedFiles.length === 0) return;
    sending = true;
    sendBtn.disabled = true;
    cancelBtn.disabled = false;
    selectedFiles.forEach(file => sendFileToAll(file));
  });

  cancelBtn.addEventListener('click', () => {
    sending = false;
    sendBtn.disabled = selectedFiles.length === 0 || peers.size === 0;
    cancelBtn.disabled = true;
    filesList.innerHTML = '';
    fileRows.clear();
  });

  /* --- SEND FILE LOGIC --- */
  async function sendFileToAll(file) {
    const meta = { filename: file.name, size: file.size, type: file.type || 'application/octet-stream' };
    const buffer = await file.arrayBuffer();
    const row = fileRows.get(file);
    const progressFill = row?.querySelector('.progress-bar-fill');

    peers.forEach(({ dataChannel }) => {
      if (!dataChannel || dataChannel.readyState !== 'open') return;

      dataChannel.send(JSON.stringify({ type: 'header', meta }));

      let offset = 0;

      function sendChunk() {
        if (!sending) return;
        if (dataChannel.bufferedAmount > 1 * 1024 * 1024) {
          dataChannel.onbufferedamountlow = () => {
            dataChannel.onbufferedamountlow = null;
            sendChunk();
          };
          return;
        }
        const end = Math.min(offset + chunkSize, buffer.byteLength);
        dataChannel.send(buffer.slice(offset, end));
        offset = end;

        if (progressFill) progressFill.style.width = Math.floor((offset / buffer.byteLength) * 100) + '%';

        if (offset < buffer.byteLength) setTimeout(sendChunk, 0);
        else dataChannel.send(JSON.stringify({ type: 'done' }));
      }

      sendChunk();
    });
  }

  /* --- UTILS --- */
  function updatePeerStatus() {
    peerStatus.textContent = `Connected peers: ${peers.size}`;
    sendBtn.disabled = selectedFiles.length === 0 || peers.size === 0;
  }

  function generateRoomId() {
    return `${Math.trunc(Math.random() * 900000) + 100000}`;
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
});
