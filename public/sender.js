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

  const receivers = new Map(); 
  let filesQueue = [];
  let totalSentFiles = 0;
  let totalSentBytes = 0;
  let isSending = false;

  const startTimeMap = new Map();

  // Sliding window params
  const CHUNK_SIZE = 512 * 1024;
  const WINDOW_SIZE = 64;
  const RETRANSMIT_TIMEOUT = 2000; // ms

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
    const iceServers = await fetch("/ice-servers").then(res => res.json()).catch(() => [{ urls: "stun:stun.l.google.com:19302" }]);
    const pc = new RTCPeerConnection({ iceServers });
    const dataChannel = pc.createDataChannel("files", { ordered: true, reliable: true });
    dataChannel.binaryType = "arraybuffer";

    receivers.set(receiverSocketId, { pc, dataChannel, lastAckedSeq: -1, pending: new Map() });

    dataChannel.onopen = () => {
      showToast(`Data channel open for receiver ${receiverSocketId}`, "success");
    };

    dataChannel.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "ack") {
          const conn = receivers.get(receiverSocketId);
          if (conn) {
            conn.lastAckedSeq = Math.max(conn.lastAckedSeq, msg.seq);
            // cleanup old pending chunks
            for (let [s] of conn.pending) {
              if (s <= conn.lastAckedSeq) conn.pending.delete(s);
            }
          }
        }
      } catch {}
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

  // FILE SELECTION + SEND
  fileInput.addEventListener('change', () => {
    const selectedFiles = Array.from(fileInput.files);
    filesQueue.push(...selectedFiles);
    const totalSize = filesQueue.reduce((acc, f) => acc + f.size, 0);
    fileMetrics.textContent = `Files Selected: ${filesQueue.length} | Total Size: ${totalSize} B`;
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
    while (filesQueue.length) await sendFile(filesQueue.shift());
    isSending = false;
    selectedFilesList.innerHTML = '';
    fileMetrics.textContent = `Files Selected: 0 | Total Size: 0 B`;
    sendBtn.disabled = true;
    cancelBtn.disabled = true;
    showToast("All files sent!", "success");
  });

  async function sendFile(file) {
    return new Promise(resolve => {
      const meta = { filename: file.name, size: file.size, type: file.type };
      const row = document.createElement('div');
      row.className = 'file-entry';
      row.innerHTML = `<div class="fname">${meta.filename}</div><div class="progress-bar"><div class="progress-bar-fill"></div></div>`;
      filesList.appendChild(row);

      receivers.forEach(({ dataChannel }) => {
        const header = JSON.stringify({ type: "header", meta });
        if (dataChannel.readyState === 'open') dataChannel.send(header);
      });

      let seq = 0;
      let offset = 0;
      startTimeMap.set(file.name, performance.now());

      function scheduleRetransmit(conn, seqNum, payload) {
        conn.pending.set(seqNum, { payload, ts: Date.now() });
      }

      function checkRetransmits() {
        receivers.forEach(conn => {
          for (let [s, { payload, ts }] of conn.pending) {
            if (Date.now() - ts > RETRANSMIT_TIMEOUT) {
              if (conn.dataChannel.readyState === "open") {
                conn.dataChannel.send(payload);
                conn.pending.set(s, { payload, ts: Date.now() });
              }
            }
          }
        });
        setTimeout(checkRetransmits, 500);
      }
      checkRetransmits();

      const reader = new FileReader();
      reader.onload = e => {
        const chunk = e.target.result;
        receivers.forEach(conn => {
          const inFlight = seq - conn.lastAckedSeq;
          if (inFlight <= WINDOW_SIZE && conn.dataChannel.readyState === "open") {
            const packet = JSON.stringify({ type: "chunk", seq, data: Array.from(new Uint8Array(chunk)) });
            conn.dataChannel.send(packet);
            scheduleRetransmit(conn, seq, packet);
          }
        });
        seq++;
        offset += chunk.byteLength;
        row.querySelector('.progress-bar-fill').style.width = `${Math.floor((offset / file.size) * 100)}%`;

        if (offset < file.size) readSlice(offset);
        else {
          receivers.forEach(({ dataChannel }) => {
            if (dataChannel.readyState === 'open') {
              dataChannel.send(JSON.stringify({ type: 'done' }));
            }
          });

          const endTime = performance.now();
          const duration = (endTime - startTimeMap.get(file.name)) / 1000;
          const speed = (file.size / 1024 / 1024 / duration).toFixed(2);
          console.log(`File ${file.name} sent in ${duration.toFixed(2)}s | Speed: ${speed} MB/s`);

          totalSentFiles++;
          totalSentBytes += file.size;
          sentMetrics.textContent = `Files Sent: ${totalSentFiles} | Total Bytes: ${totalSentBytes}`;
          resolve();
        }
      };

      function readSlice(o) {
        reader.readAsArrayBuffer(file.slice(o, o + CHUNK_SIZE));
      }
      readSlice(0);
    });
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
