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

    // ✅ DEFINED UP HERE: We need CHUNK_SIZE to calculate the buffer threshold.
    const CHUNK_SIZE = 256 * 1024; // 256KB

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
        const iceServers = await fetch("/ice-servers")
            .then(res => res.json())
            .catch(err => {
                console.error("Failed to fetch ICE servers:", err);
                return [{ urls: "stun:stun.l.google.com:19302" }];
            });

        const pc = new RTCPeerConnection({ iceServers });
        const dataChannel = pc.createDataChannel("files", { ordered: true });
        dataChannel.binaryType = "arraybuffer";

        // ✅ CRITICAL FIX: The buffer threshold was too high, exceeding internal browser limits.
        // We are reducing it drastically to be just a few multiples of the chunk size.
        // This is a more conservative but much more stable approach.
        const BUFFER_THRESHOLD = CHUNK_SIZE * 4; // 1MB (256KB * 4)
        dataChannel.bufferedAmountLowThreshold = BUFFER_THRESHOLD;

        const queue = [];
        receivers.set(receiverSocketId, { pc, dataChannel, queue });

        dataChannel.onopen = () => {
            showToast(`Data channel open for receiver ${receiverSocketId}`, "success");
            while (queue.length) dataChannel.send(queue.shift());
        };

        // ... (the rest of the 'init' handler and other socket listeners remain the same) ...
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
    
    // ... (keep all other socket listeners: answer, ice-candidate, etc.) ...
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

    // The 'sendFile' function and its while loop are now correct.
    // The only change needed was the BUFFER_THRESHOLD value.
    async function sendFile(file) {
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

        receivers.forEach(({ dataChannel }) => {
            dataChannel.send(JSON.stringify({ type: "header", meta }));
        });

        const waitForDataChannelDrain = (channel) => {
            // ✅ We are now checking against the much smaller, safer threshold
            if (channel.bufferedAmount < channel.bufferedAmountLowThreshold) {
                return Promise.resolve();
            }
            return new Promise(resolve => {
                channel.onbufferedamountlow = () => {
                    channel.onbufferedamountlow = null;
                    resolve();
                };
            });
        };

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

        while (offset < file.size) {
            const drainPromises = [];
            receivers.forEach(({ dataChannel }) => {
                drainPromises.push(waitForDataChannelDrain(dataChannel));
            });
            await Promise.all(drainPromises);

            const slice = file.slice(offset, offset + CHUNK_SIZE);
            const chunk = await slice.arrayBuffer();
            
            receivers.forEach(({ dataChannel }) => {
                dataChannel.send(chunk);
});

            offset += chunk.byteLength;
            progressBarFill.style.width = `${Math.floor((offset / file.size) * 100)}%`;
        }

        clearInterval(progressInterval);
        statsDiv.textContent = 'Done!';
        receivers.forEach(({ dataChannel }) => {
            dataChannel.send(JSON.stringify({ type: 'done' }));
        });

        totalSentFiles++;
        totalSentBytes += file.size;
        sentMetrics.textContent = `Files Sent: ${totalSentFiles} | Total Bytes: ${totalSentBytes}`;
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