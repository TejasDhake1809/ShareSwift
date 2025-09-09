// public/receiver.js
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
  let incoming = { buffer: [], meta: null, received: 0 };

  const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:your-turn-server.com:3478', username: 'user', credential: 'pass' }
  ]
};


  joinBtn.addEventListener('click', () => {
    const roomId = joinInput.value.trim();
    if (!roomId) return alert('Enter Room ID');
    joinStatus.textContent = 'Joining...';
    socket.emit('receiver-join', { roomId });
  });

  socket.on('connect', () => {
    console.log('Connected to signaling server', socket.id);
  });

  socket.on('no-sender', ({ message }) => {
    joinStatus.textContent = message || 'No sender for that room';
  });

  // server will notify sender via 'init' and sender sends offer to this socket id
  socket.on('offer', async ({ from, offer }) => {
    console.log('Received offer from', from);
    roomDisplay && (roomDisplay.textContent = `Room: ${joinInput.value.trim()}`);
    joinStatus.textContent = 'Connected';

    // create pc
    pc = new RTCPeerConnection(rtcConfig);

    pc.onicecandidate = event => {
      if (event.candidate) {
        socket.emit('ice-candidate', { to: from, candidate: event.candidate });
      }
    };

    pc.ondatachannel = event => {
      dataChannel = event.channel;
      dataChannel.binaryType = 'arraybuffer';
      dataChannel.onopen = () => {
        console.log('DataChannel open');
        receivePanel.classList.remove('hidden');
      };
      dataChannel.onmessage = handleDataMessage;
      dataChannel.onclose = () => console.log('DataChannel closed');
    };

    try {
      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { to: from, answer: pc.localDescription });
    } catch (err) {
      console.error('Error handling offer:', err);
    }
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    if (!pc || !candidate) return;
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn('Error adding ICE candidate', err);
    }
  });

  function handleDataMessage(e) {
    // strings are header/done JSON; binary are chunks
    if (typeof e.data === 'string') {
      let msg = null;
      try { msg = JSON.parse(e.data); } catch (err) { console.warn('Invalid JSON header'); return; }

      if (msg.type === 'header' && msg.meta) {
        incoming.meta = msg.meta;
        incoming.buffer = [];
        incoming.received = 0;
        // show UI row
        createIncomingEntry(msg.meta.filename);
      } else if (msg.type === 'done') {
        finishIncomingFile();
      }
    } else {
      // binary chunk
      incoming.buffer.push(e.data);
      incoming.received += e.data.byteLength;
      updateIncomingProgress(Math.floor((incoming.received / incoming.meta.size) * 100));
      // optionally auto-finish if reached size
      if (incoming.meta && incoming.received >= incoming.meta.size) {
        finishIncomingFile();
      }
    }
  }

  function createIncomingEntry(filename) {
    const row = document.createElement('div');
    row.className = 'incoming-entry';
    row.innerHTML = `<div class="fname">${escapeHtml(filename)}</div><div class="progress">0%</div>`;
    receivedFiles.appendChild(row);
    incoming.row = row;
  }

  function updateIncomingProgress(pct) {
    if (!incoming.row) return;
    const p = incoming.row.querySelector('.progress');
    p.textContent = `${pct}%`;
  }

  function finishIncomingFile() {
    if (!incoming.meta) return;
    const blob = new Blob(incoming.buffer, { type: incoming.meta.type || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = incoming.meta.filename;
    a.click();
    // cleanup row UI
    if (incoming.row) incoming.row.querySelector('.progress').textContent = 'Done';
    // reset
    incoming = { buffer: [], meta: null, received: 0, row: null };
  }

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
});
