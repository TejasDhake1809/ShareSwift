document.addEventListener('DOMContentLoaded', () => {
  const socket = io({ transports: ['websocket'] });

  const createBtn = document.getElementById('create-room-btn');
  const roomDisplay = document.getElementById('room-display');
  const sharePanel = document.getElementById('share-panel');
  const persistentRoom = document.getElementById('room-display-persistent');
  const fileInput = document.getElementById('file-input');
  const filesList = document.getElementById('files-list');

  const peerStatus = document.createElement('div');
  peerStatus.id = 'peer-status';
  sharePanel.prepend(peerStatus);

  let roomId = null;
  const peers = new Map(); // receiverSocketId -> { pc, dataChannel }
  const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  createBtn.addEventListener('click', () => {
    roomId = generateRoomId();
    // roomDisplay.textContent = `Room: ${roomId}`;
    persistentRoom.textContent = roomId;
    socket.emit('sender-join', { roomId });
    sharePanel.classList.remove('hidden');
    peerStatus.textContent = 'Connected peers: 0';
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
      peerStatus.textContent = `Connected peers: ${peers.size}`;
    };

    pc.onicecandidate = event => {
      if (event.candidate) socket.emit('ice-candidate', { to: rId, candidate: event.candidate });
    };

    peers.set(rId, { pc, dataChannel });
    peerStatus.textContent = `Connected peers: ${peers.size}`;

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: rId, offer });
      console.log('Offer sent to receiver', rId);
    } catch (err) {
      console.error('Failed to create/send offer', err);
    }
  });

  socket.on('answer', async ({ from, answer }) => {
    const peer = peers.get(from);
    if (!peer) return;
    try {
      await peer.pc.setRemoteDescription(answer);
      console.log('Remote answer set for', from);
    } catch (err) {
      console.error('Error setting remote answer for', from, err);
    }
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    const peer = peers.get(from);
    if (!peer || !candidate) return;
    try { await peer.pc.addIceCandidate(candidate); } 
    catch (err) { console.warn('Error adding ICE candidate for', from, err); }
  });

  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;

    const meta = { filename: file.name, size: file.size, type: file.type || 'application/octet-stream' };
    const chunkSize = 16 * 1024;

    peers.forEach(({ dataChannel }, rId) => {
      if (!dataChannel || dataChannel.readyState !== 'open') return;
      dataChannel.send(JSON.stringify({ type: 'header', meta }));

      const reader = new FileReader();
      let offset = 0;

      reader.onload = () => {
        const buffer = new Uint8Array(reader.result);

        function sendNextChunk() {
          if (dataChannel.bufferedAmount > 1 * 1024 * 1024) {
            dataChannel.onbufferedamountlow = () => {
              dataChannel.onbufferedamountlow = null;
              sendNextChunk();
            };
            return;
          }
          const end = Math.min(offset + chunkSize, buffer.length);
          dataChannel.send(buffer.slice(offset, end));
          offset = end;
          if (offset < buffer.length) setTimeout(sendNextChunk, 0);
          else dataChannel.send(JSON.stringify({ type: 'done' }));
        }

        sendNextChunk();
      };

      reader.readAsArrayBuffer(file);
    });
  });

  function generateRoomId() {
    return `${Math.trunc(Math.random() * 900000) + 100000}`;
  }
});
