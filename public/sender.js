// public/sender.js
document.addEventListener('DOMContentLoaded', () => {
  const socket = io({ transports: ['websocket'] });

  const createBtn = document.getElementById('create-room-btn');
  const roomDisplay = document.getElementById('room-display');
  const sharePanel = document.getElementById('share-panel');
  const persistentRoom = document.getElementById('room-display-persistent');
  const fileInput = document.getElementById('file-input');
  const filesList = document.getElementById('files-list');

  let roomId = null;
  let pc = null;
  let dataChannel = null;
  let receiverSocketId = null;

  // STUN config
  const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:your-turn-server.com:3478', username: 'user', credential: 'pass' }
  ]
};


  createBtn.addEventListener('click', () => {
    roomId = generateRoomId();
    roomDisplay.textContent = `Room: ${roomId}`;
    persistentRoom.textContent = roomId;
    socket.emit('sender-join', { roomId });
    // show share UI so user can prepare file
    sharePanel.classList.remove('hidden');
  });

  socket.on('connect', () => {
    console.log('Connected to signaling server:', socket.id);
  });

  socket.on('init', async ({ receiverSocketId: rId }) => {
    console.log('Receiver joined:', rId);
    receiverSocketId = rId;
    // Create RTCPeerConnection + DataChannel as sender (initiator)
    pc = new RTCPeerConnection(rtcConfig);

    // create data channel for file transfer
    dataChannel = pc.createDataChannel('file');
    dataChannel.binaryType = 'arraybuffer';

    dataChannel.onopen = () => {
      console.log('DataChannel open');
      // UI: ready to send files
    };

    dataChannel.onclose = () => console.log('DataChannel closed');

    pc.onicecandidate = event => {
      if (event.candidate) {
        socket.emit('ice-candidate', { to: receiverSocketId, candidate: event.candidate });
      }
    };

    // Create offer
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: receiverSocketId, offer });
      console.log('Offer sent to receiver');
    } catch (err) {
      console.error('Failed to create/send offer', err);
    }
  });

  // Receiver will send answer
  socket.on('answer', async ({ from, answer }) => {
    if (!pc) {
      console.warn('No pc to set remote answer on');
      return;
    }
    try {
      // setRemoteDescription only when have-local-offer
      if (pc.signalingState === 'have-local-offer' || pc.signalingState === 'stable') {
        await pc.setRemoteDescription(answer);
        console.log('Remote answer set');
      } else {
        // attempt anyway
        await pc.setRemoteDescription(answer);
      }
    } catch (err) {
      console.error('Error setting remote answer', err);
    }
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    if (!pc || !candidate) return;
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn('Error adding remote ICE candidate', err);
    }
  });

  socket.on('no-sender', ({ message }) => {
    alert(message || 'No sender found for that room ID');
  });

  // file selection -> send file via data channel (header + binary chunks + done)
  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    if (!dataChannel || dataChannel.readyState !== 'open') {
      alert('Receiver not connected yet. Wait until receiver joins and the connection is established.');
      return;
    }

    const meta = { filename: file.name, size: file.size, type: file.type || 'application/octet-stream' };
    // display entry
    const entry = createFileEntry(file.name);
    // send header
    dataChannel.send(JSON.stringify({ type: 'header', meta }));

    const chunkSize = 16 * 1024; // 16KB
    const reader = new FileReader();
    let offset = 0;

    reader.onload = () => {
      const buffer = new Uint8Array(reader.result);

      function sendNextChunk() {
        // backpressure: if bufferedAmount is large, wait
        if (dataChannel.bufferedAmount > 1 * 1024 * 1024) { // 1MB
          dataChannel.onbufferedamountlow = () => {
            dataChannel.onbufferedamountlow = null;
            sendNextChunk();
          };
          return;
        }

        const end = Math.min(offset + chunkSize, buffer.length);
        const slice = buffer.slice(offset, end);
        dataChannel.send(slice);
        offset = end;

        const sentPct = Math.floor((offset / buffer.length) * 100);
        updateFileEntry(entry, sentPct);

        if (offset < buffer.length) {
          // schedule next chunk
          setTimeout(sendNextChunk, 0);
        } else {
          // done
          dataChannel.send(JSON.stringify({ type: 'done' }));
          updateFileEntry(entry, 100, true);
        }
      }

      sendNextChunk();
    };

    reader.readAsArrayBuffer(file);
  });

  // helpers
  function generateRoomId() {
    return `${Math.trunc(Math.random() * 900000) + 100000}`; // 6-digit
  }

  function createFileEntry(name) {
    const el = document.createElement('div');
    el.className = 'file-entry';
    el.innerHTML = `<div class="fname">${escapeHtml(name)}</div><div class="progress">0%</div>`;
    filesList.appendChild(el);
    return el;
  }

  function updateFileEntry(el, pct, done = false) {
    const p = el.querySelector('.progress');
    p.textContent = (done ? 'Done' : `${pct}%`);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
});
