// sender.js (Corrected with ACK system)

document.addEventListener('DOMContentLoaded', () => {
    const socket = io({ transports: ['websocket'] });
    // ... (get all UI elements as before) ...
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
    const CHUNK_SIZE = 256 * 1024;

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
        const iceServers = await fetch("/ice-servers").then(res => res.json()).catch(err => [{ urls: "stun:stun.l.google.com:19302" }]);
        const pc = new RTCPeerConnection({ iceServers });
        const dataChannel = pc.createDataChannel("files", { ordered: true });
        dataChannel.binaryType = "arraybuffer";
        
        // ✅ NEW: Create a resolver for the ACK promise
        let ackResolver = null;
        
        const conn = { 
            pc, 
            dataChannel,
            // Function to wait for the next ACK
            waitForAck: () => new Promise(resolve => { ackResolver = resolve; })
        };
        receivers.set(receiverSocketId, conn);

        dataChannel.onopen = () => showToast(`Data channel open for ${receiverSocketId}`, "success");
        
        // ✅ NEW: Message handler to resolve the ACK promise
        dataChannel.onmessage = e => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'ack' && ackResolver) {
                ackResolver();
                ackResolver = null; // Reset for next chunk
            }
        };

        // ... (rest of 'init' is the same: ice states, candidate, offer) ...
        pc.oniceconnectionstatechange = () => console.log(`ICE state for ${receiverSocketId}:`, pc.iceConnectionState);
        pc.onconnectionstatechange = () => console.log(`Connection state for ${receiverSocketId}:`, pc.connectionState);
        pc.onicecandidate = event => {
            if (event.candidate) socket.emit('ice-candidate', { to: receiverSocketId, candidate: event.candidate });
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { to: receiverSocketId, offer: pc.localDescription });
    });

    // ... (All other socket listeners are the same) ...
    socket.on('answer', async ({ from, answer }) => {
        const conn = receivers.get(from);
        if (conn) await conn.pc.setRemoteDescription(answer);
    });
    socket.on('ice-candidate', async ({ candidate, from }) => {
        const conn = receivers.get(from);
        if (conn) await conn.pc.addIceCandidate(candidate).catch(err => console.warn(err));
    });
    socket.on('receiver-disconnect', ({ receiverId }) => {
        const conn = receivers.get(receiverId);
        if (conn) {
            if (conn.dataChannel) conn.dataChannel.close();
            if (conn.pc) conn.pc.close();
            receivers.delete(receiverId);
            peerStatus.textContent = `Connected peers: ${receivers.size}`;
        }
    });
    socket.on('update-receivers', ({ count }) => {
        peerStatus.textContent = `Connected peers: ${count}`;
    });

    // ... (fileInput listener is the same) ...
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
        sendBtn.disabled = true;
        while (filesQueue.length) await sendFile(filesQueue.shift());
        isSending = false;
        selectedFilesList.innerHTML = '';
        fileMetrics.textContent = `Files Selected: 0 | Total Size: 0 B`;
        cancelBtn.disabled = true;
        showToast("All files sent!", "success");
    });
    
    // ✅ REWRITTEN FUNCTION: sendFile now uses the ACK system.
    async function sendFile(file) {
        let offset = 0;
        const meta = { filename: file.name, size: file.size, type: file.type };
        const row = document.createElement('div');
        row.className = 'file-entry';
        row.innerHTML = `<div class="fname">${meta.filename}</div><div class="progress-bar"><div class="progress-bar-fill"></div></div>`;
        filesList.appendChild(row);
        const progressBarFill = row.querySelector('.progress-bar-fill');

        receivers.forEach(({ dataChannel }) => {
            dataChannel.send(JSON.stringify({ type: "header", meta }));
        });

        while (offset < file.size) {
            // 1. Read a chunk
            const slice = file.slice(offset, offset + CHUNK_SIZE);
            const chunk = await slice.arrayBuffer();

            // 2. Send the chunk to all receivers
            receivers.forEach(({ dataChannel }) => dataChannel.send(chunk));
            
            // 3. Wait for an ACK from all receivers
            const ackPromises = [];
            receivers.forEach(conn => ackPromises.push(conn.waitForAck()));
            await Promise.all(ackPromises);
            
            // 4. Update progress
            offset += chunk.byteLength;
            progressBarFill.style.width = `${Math.floor((offset / file.size) * 100)}%`;
        }

        receivers.forEach(({ dataChannel }) => {
            dataChannel.send(JSON.stringify({ type: 'done' }));
        });
        totalSentFiles++;
        totalSentBytes += file.size;
        sentMetrics.textContent = `Files Sent: ${totalSentFiles} | Total Bytes: ${totalSentBytes}`;
    }

    // ... (cancelBtn listener is the same) ...
    cancelBtn.addEventListener('click', () => {
        filesQueue = [];
        selectedFilesList.innerHTML = '';
        fileMetrics.textContent = `Files Selected: 0 | Total Size: 0 B`;
        sendBtn.disabled = true;
        cancelBtn.disabled = true;
        showToast("File selection canceled", "error");
    });
});