document.addEventListener('DOMContentLoaded', () => {
  const socket = io({ transports: ['websocket'] });

  const createBtn = document.getElementById('create-room-btn');
  const persistentRoom = document.getElementById('room-display-persistent');
  const sharePanel = document.getElementById('share-panel');

  const fileInput = document.getElementById('file-input');
  const sendBtn = document.getElementById('send-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const filesList = document.getElementById('files-list');
  const peerStatus = document.getElementById('peer-status');
  const fileMetrics = document.getElementById('file-metrics');

  let roomId = null;
  const peers = new Map(); // receiverSocketId -> { pc, dataChannel }
  const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  let currentFile = null;
  let sending = false;
  let stopSending = false;

  createBtn.addEventListener('click', () => {
    roomId = generateRoomId();
    persistentRoom.textContent = roomId;
    socket.emit('sender-join', { roomId });
    sharePanel.classList.remove('hidden');
    updateMetrics();
  });

  socket.on('connect', () => console.log('Connected to signaling server:', socket.id));

  socket.on('init', async ({ receiverSocketId: rId }) => {
    console.log('Receiver joined:', rId);

    const pc = new RTCPeerConnection(rtcConfig);
    const dataChannel = pc.createDataChannel('file');
    dataChannel.binaryType = 'arraybuffer';

    dataChannel.onopen = () => console.log('DataChannel open for', rId);
    dataChannel.onclose = () => {
      console.log('DataChannel closed for', rId);
      peers.delete(rId);
      updateMetrics();
    };

    pc.onicecandidate = event => {
      if (event.candidate) socket.emit('ice-candidate', { to: rId, candidate: event.candidate });
    };

    peers.set(rId, { pc, dataChannel });
    updateMetrics();

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: rId, offer });
    } catch (err) { console.error(err); }
  });

  socket.on('answer', async ({ from, answer }) => {
    const peer = peers.get(from);
    if (!peer) return;
    try { await peer.pc.setRemoteDescription(answer); } 
    catch (err) { console.error(err); }
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    const peer = peers.get(from);
    if (!peer || !candidate) return;
    try { await peer.pc.addIceCandidate(candidate); } 
    catch (err) { console.warn(err); }
  });

  fileInput.addEventListener('change', e => {
    currentFile = e.target.files[0];
    sendBtn.disabled = !currentFile;
    cancelBtn.disabled = true;
    updateMetrics();
    if (currentFile) addFileEntry(currentFile.name, currentFile.size);
  });

  sendBtn.addEventListener('click', () => {
    if (!currentFile) return;
    sending = true;
    stopSending = false;
    sendBtn.disabled = true;
    cancelBtn.disabled = false;
    sendFile(currentFile);
  });

  cancelBtn.addEventListener('click', () => {
    stopSending = true;
    sending = false;
    sendBtn.disabled = false;
    cancelBtn.disabled = true;
  });

  function sendFile(file) {
    const chunkSize = 16 * 1024;
    const meta = { filename: file.name, size: file.size, type: file.type || 'application/octet-stream' };

    peers.forEach(({ dataChannel }) => {
      if (!dataChannel || dataChannel.readyState !== 'open') return;
      dataChannel.send(JSON.stringify({ type: 'header', meta }));
    });

    const reader = new FileReader();
    let offset = 0;

    reader.onload = () => {
      const buffer = new Uint8Array(reader.result);

      function sendNextChunk() {
        if (stopSending) return finalizeCancel();
        peers.forEach(({ dataChannel }) => {
          if (dataChannel.readyState === 'open') {
            const end = Math.min(offset + chunkSize, buffer.length);
            dataChannel.send(buffer.slice(offset, end));
          }
        });

        offset += chunkSize;
        updateFileProgress(offset, file.size);

        if (offset < buffer.length) setTimeout(sendNextChunk, 0);
        else finalizeSend();
      }

      sendNextChunk();
    };

    reader.readAsArrayBuffer(file);
  }

  function finalizeSend() {
    peers.forEach(({ dataChannel }) => {
      if (dataChannel.readyState === 'open') dataChannel.send(JSON.stringify({ type: 'done' }));
    });
    sending = false;
    stopSending = false;
    cancelBtn.disabled = true;
    sendBtn.disabled = false;
    currentFile = null;
    updateMetrics();
  }

  function finalizeCancel() {
    sending = false;
    stopSending = false;
    cancelBtn.disabled = true;
    sendBtn.disabled = false;
    currentFile = null;
    console.log('Sending canceled');
  }

  function addFileEntry(name, size) {
    const row = document.createElement('div');
    row.className = 'file-entry';
    row.innerHTML = `<div class="fname">${name}</div>
                     <div class="progress-bar"><div class="progress-bar-fill"></div></div>`;
    filesList.appendChild(row);
  }

  function updateFileProgress(sent, total) {
    const pct = Math.floor((sent / total) * 100);
    const fill = filesList.lastChild.querySelector('.progress-bar-fill');
    if (fill) fill.style.width = pct + '%';
  }

  function updateMetrics() {
    peerStatus.textContent = `Connected peers: ${peers.size}`;
    fileMetrics.textContent = `Files selected: ${currentFile ? 1 : 0} | Total bytes: ${currentFile ? currentFile.size : 0}`;
  }

  function generateRoomId() {
    return `${Math.trunc(Math.random() * 900000) + 100000}`;
  }
});
