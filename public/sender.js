// sender.js (Complete File)

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

    const CHUNK_SIZE = 256 * 1024; // 256KB

    function showToast(msg, type = "info") {
        const bg = type === "error" ? "#e74c3c" : type === "success" ? "#2ecc71" : "#3498db";
        Toastify({ text: msg, duration: 2000, gravity: "top", position: "right", style: { background: bg } }).showToast();
    }

    createRoomBtn.addEventListener('click', () => socket.emit('create-room'));

    socket.on('room-created', ({ roomId }) => {
        roomDisplay.textContent = roomId;
        sharePanel.classList.remove('hidden');
    });

    socket.on('init', async ({ receiverSocketId }) => {
        const iceServers = await fetch("/ice-servers").then(res => res.json()).catch(err => [{ urls: "stun:stun.l.google.com:19302" }]);
        const pc = new RTCPeerConnection({ iceServers });
        const dataChannel = pc.createDataChannel("files", { ordered: true });
        dataChannel.binaryType = "arraybuffer";
        
        // Use a safe, conservative buffer threshold to prevent crashes.
        const BUFFER_THRESHOLD = CHUNK_SIZE * 4; // 1MB
        dataChannel.bufferedAmountLowThreshold = BUFFER_THRESHOLD;
        
        receivers.set(receiverSocketId, { pc, dataChannel });
        
        pc.onicecandidate = event => {
            if (event.candidate) socket.emit('ice-candidate', { to: receiverSocketId, candidate: event.candidate });
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { to: receiverSocketId, offer: pc.localDescription });
    });
    
    socket.on('answer', async ({ from, answer }) => {
        const conn = receivers.get(from);
        if (conn) await conn.pc.setRemoteDescription(answer);
    });

    socket.on('ice-candidate', async ({ candidate, from }) => {
        const conn = receivers.get(from);
        if (conn) await conn.pc.addIceCandidate(candidate).catch(console.warn);
    });

    socket.on('receiver-disconnect', ({ receiverId }) => {
        const conn = receivers.get(receiverId);
        if (conn) {
            conn.dataChannel?.close();
            conn.pc?.close();
            receivers.delete(receiverId);
            peerStatus.textContent = `Connected peers: ${receivers.size}`;
        }
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

    function sendFile(file) {
        return new Promise((resolve, reject) => {
            let offset = 0;
            const meta = { filename: file.name, size: file.size, type: file.type };
            const row = document.createElement('div');
            row.className = 'file-entry';
            row.innerHTML = `<div class="fname">${meta.filename}</div><div class="progress-bar"><div class="progress-bar-fill"></div></div>`;
            filesList.appendChild(row);
            const progressBarFill = row.querySelector('.progress-bar-fill');

            receivers.forEach(({ dataChannel }) => {
                if (dataChannel.readyState === 'open') {
                    dataChannel.send(JSON.stringify({ type: "header", meta }));
                }
            });

            const reader = new FileReader();

            reader.onload = (e) => {
                receivers.forEach(({ dataChannel }) => {
                    if (dataChannel.readyState === 'open') {
                        try {
                            dataChannel.send(e.target.result);
                        } catch (err) {
                            console.error("Send failed:", err);
                            return reject(err);
                        }
                    }
                });

                offset += e.target.result.byteLength;
                progressBarFill.style.width = `${Math.floor((offset / file.size) * 100)}%`;

                if (offset < file.size) {
                    const firstChannel = receivers.values().next().value?.dataChannel;
                    if (firstChannel && firstChannel.bufferedAmount < firstChannel.bufferedAmountLowThreshold) {
                        readNextChunk();
                    }
                } else {
                    receivers.forEach(({ dataChannel }) => {
                        if (dataChannel.readyState === 'open') {
                            dataChannel.send(JSON.stringify({ type: 'done' }));
                        }
                    });
                    totalSentFiles++;
                    totalSentBytes += file.size;
                    sentMetrics.textContent = `Files Sent: ${totalSentFiles} | Total Bytes: ${totalSentBytes}`;
                    resolve();
                }
            };

            reader.onerror = (err) => reject(err);

            const readNextChunk = () => {
                const slice = file.slice(offset, offset + CHUNK_SIZE);
                reader.readAsArrayBuffer(slice);
            };

            receivers.forEach(({ dataChannel }) => {
                dataChannel.onbufferedamountlow = () => {
                    if (offset < file.size) {
                        readNextChunk();
                    }
                };
            });
            
            readNextChunk();
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
        navigator.clipboard.writeText(roomDisplay.textContent)
            .then(() => showToast("Room ID copied!", "success"));
    });
});