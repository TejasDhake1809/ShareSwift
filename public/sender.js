// sender.js

document.addEventListener('DOMContentLoaded', () => {
    const socket = io({ transports: ['websocket'] });

    // ... (keep all the variable declarations and UI element getters) ...
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


    function showToast(msg, type = "info") {
        const bg = type === "error" ? "#e74c3c" : type === "success" ? "#2ecc71" : "#3498db";
        Toastify({ text: msg, duration: 2000, gravity: "top", position: "right", style: { background: bg } }).showToast();
    }

    // ... (keep all socket listeners from 'create-room-btn' down to 'sendBtn.addEventListener') ...
    createRoomBtn.addEventListener('click', () => socket.emit('create-room'));

    socket.on('room-created', ({ roomId }) => {
        roomDisplay.textContent = roomId;
        sharePanel.classList.remove('hidden');
        showToast(`Room ${roomId} created`, "success");
    });

    socket.on('init', async ({ receiverSocketId }) => {
        const iceServers = await fetch("/ice-servers")
            .then(res => res.json())
            .catch(err => {
                console.error("Failed to fetch ICE servers:", err);
                return [{ urls: "stun:stun.l.google.com:19302" }];
            });

        const pc = new RTCPeerConnection({ iceServers });
        const dataChannel = pc.createDataChannel("files", { ordered: true });
        dataChannel.binaryType = "arraybuffer";

        const BUFFER_THRESHOLD = 64 * 1024 * 1024; // 64MB
        dataChannel.bufferedAmountLowThreshold = BUFFER_THRESHOLD;
        
        const queue = [];
        receivers.set(receiverSocketId, { pc, dataChannel, queue });

        dataChannel.onopen = () => {
            showToast(`Data channel open for receiver ${receiverSocketId}`, "success");
            while (queue.length) dataChannel.send(queue.shift());
        };

        dataChannel.onmessage = e => console.log(`Received from ${receiverSocketId}:`, e.data);
        pc.oniceconnectionstatechange = () => console.log(`ICE state for ${receiverSocketId}:`, pc.iceConnectionState);
        pc.onconnectionstatechange = () => console.log(`Connection state for ${receiverSocketId}:`, pc.connectionState);

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
        while (filesQueue.length) {
            await sendFile(filesQueue.shift());
        }
        isSending = false;
        selectedFilesList.innerHTML = '';
        fileMetrics.textContent = `Files Selected: 0 | Total Size: 0 B`;
        cancelBtn.disabled = true;
        showToast("All files sent!", "success");
    });


    // ✅ REWRITTEN FUNCTION: This is a complete replacement of the old sendFile function.
    async function sendFile(file) {
        const CHUNK_SIZE = 256 * 1024;
        let offset = 0;
        let lastBytesSent = 0;
        let lastTimestamp = Date.now();
        let progressInterval;

        const meta = { filename: file.name, size: file.size, type: file.type };
        const row = document.createElement('div');
        row.className = 'file-entry';
        row.innerHTML = `<div class="fname">${meta.filename}</div><div class="progress-bar"><div class="progress-bar-fill"></div></div><div class="stats"></div>`;
        filesList.appendChild(row);
        const statsDiv = row.querySelector('.stats');
        const progressBarFill = row.querySelector('.progress-bar-fill');

        // Send file header
        receivers.forEach(({ dataChannel }) => {
            dataChannel.send(JSON.stringify({ type: "header", meta }));
        });

        // ✨ NEW: Helper function that returns a promise that resolves when a data channel's buffer is drained.
        const waitForDataChannelDrain = (channel) => {
            if (channel.bufferedAmount < channel.bufferedAmountLowThreshold) {
                return Promise.resolve();
            }
            return new Promise(resolve => {
                channel.onbufferedamountlow = () => {
                    channel.onbufferedamountlow = null; // Remove listener
                    resolve();
                };
            });
        };

        // Start the progress timer
        progressInterval = setInterval(() => {
            const now = Date.now();
            const interval = (now - lastTimestamp) / 1000;
            if (interval > 0) {
                const speed = (offset - lastBytesSent) / interval;
                const remainingBytes = file.size - offset;
                const eta = speed > 0 ? remainingBytes / speed : Infinity;
                statsDiv.textContent = `${(speed / 1024 / 1024).toFixed(2)} MB/s | ETA: ${isFinite(eta) ? Math.round(eta) : '...'}s`;
            }
            lastBytesSent = offset;
            lastTimestamp = now;
        }, 1000);

        // ✨ NEW: The main sending logic is now a controlled while loop.
        while (offset < file.size) {
            // 1. Wait for all channels to have space in their buffers. This is the key change.
            const drainPromises = [];
            receivers.forEach(({ dataChannel }) => {
                drainPromises.push(waitForDataChannelDrain(dataChannel));
            });
            await Promise.all(drainPromises);

            // 2. Read the next chunk of the file.
            const slice = file.slice(offset, offset + CHUNK_SIZE);
            // ✨ NEW: Using the modern blob.arrayBuffer() which returns a promise. No more FileReader events.
            const chunk = await slice.arrayBuffer();
            
            // 3. Send the chunk to all receivers.
            receivers.forEach(({ dataChannel }) => {
                dataChannel.send(chunk);
            });

            // 4. Update offset and UI.
            offset += chunk.byteLength;
            progressBarFill.style.width = `${Math.floor((offset / file.size) * 100)}%`;
        }

        // --- Cleanup after the loop finishes ---
        clearInterval(progressInterval);
        statsDiv.textContent = 'Done!';
        receivers.forEach(({ dataChannel }) => {
            dataChannel.send(JSON.stringify({ type: 'done' }));
        });

        totalSentFiles++;
        totalSentBytes += file.size;
        sentMetrics.textContent = `Files Sent: ${totalSentFiles} | Total Bytes: ${totalSentBytes}`;
    }

    // ... (keep cancelBtn and roomDisplay listeners)
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