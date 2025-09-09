document.addEventListener('DOMContentLoaded', () => {
  const socket = io({ transports: ['websocket'] });
  const joinInput = document.getElementById('join-room-input');
  const joinBtn = document.getElementById('join-room-btn');
  const joinStatus = document.getElementById('join-status');
  const receivePanel = document.getElementById('receive-panel');
  const receivedFiles = document.getElementById('received-files');
  const roomDisplay = document.getElementById('room-display');

  let pc = null;
  let dataChannel = null;
  let incoming = { buffer: [], meta: null, received: 0, row: null };
  const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  joinBtn.addEventListener('click', () => {
    const roomId = joinInput.value.trim();
    if (!roomId) return alert('Enter Room ID');
    joinStatus.textContent = 'Joining...';
    socket.emit('receiver-join', { roomId });
  });

  socket.on('offer', async ({ from, offer }) => {
    roomDisplay.textContent = `Room: ${joinInput.value.trim()}`;
    joinStatus.textContent = 'Connected';
    pc = new RTCPeerConnection(rtcConfig);

    pc.onicecandidate = event => {
      if (event.candidate) socket.emit('ice-candidate', { to: from, candidate: event.candidate });
    };

    pc.ondatachannel = event => {
      dataChannel = event.channel;
      dataChannel.binaryType = 'arraybuffer';
      dataChannel.onopen = () => receivePanel.classList.remove('hidden');
      dataChannel.onmessage = handleDataMessage;
    };

    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: from, answer: pc.localDescription });
  });

  socket.on('ice-candidate', async ({ candidate }) => await pc?.addIceCandidate(candidate));

  function handleDataMessage(e) {
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data);
      if (msg.type === 'header') {
        incoming.meta = msg.meta;
        incoming.buffer = [];
        incoming.received = 0;
        const row = document.createElement('div');
        row.className = 'incoming-entry';
        row.innerHTML = `<div class="fname">${msg.meta.filename}</div>
                         <div class="progress-bar"><div class="progress-bar-fill"></div></div>`;
        receivedFiles.appendChild(row);
        incoming.row = row;
      } else if (msg.type === 'done') finishIncomingFile();
    } else {
      incoming.buffer.push(e.data);
      incoming.received += e.data.byteLength;
      const pct = Math.floor((incoming.received / incoming.meta.size) * 100);
      incoming.row.querySelector('.progress-bar-fill').style.width = pct + '%';
      if (incoming.received >= incoming.meta.size) finishIncomingFile();
    }
  }

  function finishIncomingFile() {
    if (!incoming.meta) return;
    const blob = new Blob(incoming.buffer, { type: incoming.meta.type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = incoming.meta.filename;
    a.click();
    incoming.row.querySelector('.progress-bar-fill').style.width = '100%';
    incoming = { buffer: [], meta: null, received: 0, row: null };
  }
});
