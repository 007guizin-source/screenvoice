const socket = io();

const home = document.getElementById("home");
const roomEl = document.getElementById("room");
const nameInput = document.getElementById("name");
const roomCodeInput = document.getElementById("roomCode");
const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");
const homeError = document.getElementById("homeError");
const roomCodeLabel = document.getElementById("roomCodeLabel");
const peopleEl = document.getElementById("people");
const countEl = document.getElementById("count");
const screensEl = document.getElementById("screens");
const emptyStage = document.getElementById("emptyStage");
const micBtn = document.getElementById("micBtn");
const screenBtn = document.getElementById("screenBtn");
const leaveBtn = document.getElementById("leaveBtn");
const copyBtn = document.getElementById("copyBtn");
const statusEl = document.getElementById("status");
const toast = document.getElementById("toast");
const audioBtn = document.getElementById("audioBtn");

let audioUnlocked = false;

let currentRoom = null;
let myName = "";
let localStream = null;
let screenStream = null;
let micEnabled = true;
let outgoingAudioStream = null;
let audioContext = null;
let audioDestination = null;
let micAudioSource = null;
let screenAudioSource = null;
const peers = new Map();
const remoteStreams = new Map();

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

function randomRoom() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function setError(msg) {
  homeError.textContent = msg || "";
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3000);
}

function getRoomFromUrl() {
  const parts = location.pathname.split("/").filter(Boolean);
  return parts[0] === "room" ? parts[1] : "";
}

const urlRoom = getRoomFromUrl();
if (urlRoom) roomCodeInput.value = urlRoom.toUpperCase();

createBtn.onclick = () => {
  const name = getName();
  if (!name) return;
  const code = randomRoom();
  history.pushState({}, "", `/room/${code}`);
  join(code, name);
};

joinBtn.onclick = () => {
  const name = getName();
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!name) return;
  if (!code) return setError("Digite o código da sala.");
  history.pushState({}, "", `/room/${code}`);
  join(code, name);
};

nameInput.addEventListener("keydown", e => {
  if (e.key === "Enter") joinBtn.click();
});
roomCodeInput.addEventListener("keydown", e => {
  if (e.key === "Enter") joinBtn.click();
});

function getName() {
  const name = nameInput.value.trim().slice(0, 30);
  if (!name) {
    setError("Digite seu nome.");
    nameInput.focus();
    return null;
  }
  setError("");
  localStorage.setItem("screenvoice_name", name);
  return name;
}

nameInput.value = localStorage.getItem("screenvoice_name") || "";

async function join(roomId, name) {
  currentRoom = roomId;
  myName = name;
  statusEl.textContent = "Entrando na sala...";

  socket.emit("join-room", { roomId, name }, async result => {
    if (!result?.ok) {
      setError(result?.error || "Não foi possível entrar.");
      statusEl.textContent = "Não conectado";
      return;
    }

    home.classList.add("hidden");
    roomEl.classList.remove("hidden");
    roomCodeLabel.textContent = result.roomId;
    setError("");
    renderPeople(result.users.concat([{ socketId: socket.id, name: myName }]));

    try {
      await startMicrophone();
      statusEl.textContent = "Conectado";
    } catch (error) {
      statusEl.textContent = "Conectado — microfone bloqueado";
      handleMicError(error);
    }

    // Somente os usuários que já estavam na sala iniciam a negociação.
    // O usuário novo apenas espera os offers, evitando colisões WebRTC.
    for (const user of result.users) {
      createPeer(user.socketId, user.name, false);
    }
  });
}

async function startMicrophone() {
  if (localStream) return localStream;

  if (!navigator.mediaDevices?.getUserMedia) {
    const error = new Error("getUserMedia não está disponível neste navegador/contexto.");
    error.name = "NotSupportedError";
    throw error;
  }

  localStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  });

  micEnabled = true;
  updateMicButton();
  return localStream;
}


function ensureAudioMixer() {
  if (audioDestination) return audioDestination;
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  audioDestination = audioContext.createMediaStreamDestination();
  outgoingAudioStream = audioDestination.stream;
  return audioDestination;
}

async function updateOutgoingAudio() {
  if (!localStream && !screenStream) return;
  const destination = ensureAudioMixer();

  try {
    if (audioContext.state === "suspended") await audioContext.resume();
  } catch {}

  if (micAudioSource) {
    try { micAudioSource.disconnect(); } catch {}
    micAudioSource = null;
  }
  if (screenAudioSource) {
    try { screenAudioSource.disconnect(); } catch {}
    screenAudioSource = null;
  }

  if (localStream?.getAudioTracks().length) {
    micAudioSource = audioContext.createMediaStreamSource(new MediaStream(localStream.getAudioTracks()));
    micAudioSource.connect(destination);
  }

  if (screenStream?.getAudioTracks().length) {
    screenAudioSource = audioContext.createMediaStreamSource(new MediaStream(screenStream.getAudioTracks()));
    screenAudioSource.connect(destination);
  }

  const mixedTrack = outgoingAudioStream?.getAudioTracks()[0] || null;
  for (const peer of peers.values()) {
    if (!peer.audioSender) continue;
    await peer.audioSender.replaceTrack(mixedTrack);
  }
}

function createPeer(remoteId, remoteName, initiator) {
  if (peers.has(remoteId)) return peers.get(remoteId);

  const pc = new RTCPeerConnection(rtcConfig);
  const peer = {
    pc,
    remoteName: remoteName || "Convidado",
    pendingIce: [],
    makingOffer: false,
    polite: !initiator
  };
  peers.set(remoteId, peer);

  // Reserve uma faixa de vídeo desde o início. Assim, compartilhar/parar a tela
  // usa replaceTrack() e não precisa de uma nova negociação.
  const videoTransceiver = pc.addTransceiver("video", { direction: "sendrecv" });
  peer.videoSender = videoTransceiver.sender;

  const audioTransceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
  peer.audioSender = audioTransceiver.sender;

  // Envia um único áudio misturado (microfone + áudio da tela/aba, quando disponível).
  updateOutgoingAudio().catch(error => console.warn("Áudio de saída:", error));

  pc.onicecandidate = event => {
    if (event.candidate) {
      socket.emit("signal", {
        to: remoteId,
        data: { type: "ice", candidate: event.candidate }
      });
    }
  };

  pc.ontrack = event => {
    let stream = remoteStreams.get(remoteId);
    if (!stream) {
      stream = new MediaStream();
      remoteStreams.set(remoteId, stream);
    }

    if (!stream.getTracks().some(track => track.id === event.track.id)) {
      stream.addTrack(event.track);
    }

    renderRemoteStream(remoteId, stream, peer.remoteName);

    event.track.onended = () => {
      if (stream.getTracks().some(track => track.id === event.track.id)) {
        stream.removeTrack(event.track);
      }
      if (stream.getTracks().length === 0) {
        remoteStreams.delete(remoteId);
        document.getElementById(`screen-${remoteId}`)?.remove();
        updateEmptyStage();
      }
    };
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      statusEl.textContent = "Conectado";
    }
    if (["failed", "closed"].includes(pc.connectionState)) {
      removePeer(remoteId);
    }
  };

  if (initiator) {
    makeOffer(remoteId).catch(error => console.error("Erro ao criar offer:", error));
  }

  return peer;
}

async function makeOffer(remoteId) {
  const peer = peers.get(remoteId);
  if (!peer) return;
  const pc = peer.pc;

  if (pc.signalingState !== "stable") return;

  peer.makingOffer = true;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("signal", {
      to: remoteId,
      data: { type: "offer", sdp: pc.localDescription }
    });
  } finally {
    peer.makingOffer = false;
  }
}

socket.on("user-joined", ({ socketId, name }) => {
  renderPeople();
  // Quem já estava na sala inicia a conexão com quem acabou de entrar.
  createPeer(socketId, name, true);
});

socket.on("signal", async ({ from, data }) => {
  let peer = peers.get(from);
  if (!peer) peer = createPeer(from, "Convidado", false);

  const pc = peer.pc;

  try {
    if (data.type === "offer") {
      const offerCollision = peer.makingOffer || pc.signalingState !== "stable";
      if (offerCollision && !peer.polite) return;

      if (offerCollision) {
        await pc.setLocalDescription({ type: "rollback" });
      }

      await pc.setRemoteDescription(data.sdp);
      await flushPendingIce(peer);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("signal", {
        to: from,
        data: { type: "answer", sdp: pc.localDescription }
      });
    } else if (data.type === "answer") {
      if (pc.signalingState !== "have-local-offer") return;
      await pc.setRemoteDescription(data.sdp);
      await flushPendingIce(peer);
    } else if (data.type === "ice" && data.candidate) {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(data.candidate);
      } else {
        peer.pendingIce.push(data.candidate);
      }
    }
  } catch (error) {
    console.error("Erro WebRTC:", error);
  }
});

async function flushPendingIce(peer) {
  if (!peer.pc.remoteDescription) return;
  const candidates = peer.pendingIce.splice(0);
  for (const candidate of candidates) {
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (error) {
      console.warn("Não foi possível adicionar ICE:", error);
    }
  }
}

socket.on("user-left", ({ socketId }) => {
  removePeer(socketId);
  renderPeople();
});

socket.on("room-users", users => {
  renderPeople(users);
});

socket.on("screen-state", ({ socketId, name, sharing }) => {
  if (sharing) {
    showToast(`${name || "Alguém"} começou a compartilhar a tela.`);
  }
});

function removePeer(id) {
  const peer = peers.get(id);
  if (peer) {
    peer.pc.close();
    peers.delete(id);
  }
  remoteStreams.delete(id);
  document.getElementById(`screen-${id}`)?.remove();
  updateEmptyStage();
}

function renderPeople(users) {
  if (!users) {
    users = [...peers.entries()]
      .map(([socketId, p]) => ({ socketId, name: p.remoteName }))
      .concat([{ socketId: socket.id, name: myName }]);
  }

  const unique = [...new Map(users.map(u => [u.socketId, u])).values()];
  peopleEl.innerHTML = unique.map(user => `
    <div class="person">
      <span class="dot"></span>
      <span class="person-name">${escapeHtml(user.name)}${user.socketId === socket.id ? " (você)" : ""}</span>
    </div>
  `).join("");
  countEl.textContent = unique.length;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}

async function unlockRemoteAudio() {
  audioUnlocked = true;
  const videos = [...document.querySelectorAll(".remote-screen-video")];
  let played = 0;
  for (const video of videos) {
    try {
      video.muted = false;
      await video.play();
      played++;
    } catch (error) {
      console.warn("Áudio remoto ainda bloqueado:", error);
    }
  }
  if (audioBtn) {
    audioBtn.textContent = played || videos.length ? "🔊 Áudio ativado" : "🔊 Ativar áudio";
    audioBtn.classList.toggle("active", played > 0 || audioUnlocked);
  }
  if (played > 0) showToast("Áudio da transmissão ativado.");
  else if (videos.length) showToast("Toque novamente no botão para liberar o áudio.");
}

async function requestFullscreenVideo(video) {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen?.();
      return;
    }

    if (video.requestFullscreen) {
      await video.requestFullscreen();
      return;
    }

    // iPhone/iPad Safari uses the non-standard video fullscreen API.
    if (typeof video.webkitEnterFullscreen === "function") {
      video.webkitEnterFullscreen();
      return;
    }

    showToast("Tela cheia não é suportada por este navegador.");
  } catch (error) {
    console.warn("Tela cheia:", error);
    showToast("Toque novamente no botão de tela cheia.");
  }
}

if (audioBtn) audioBtn.onclick = unlockRemoteAudio;

async function toggleMic() {
  try {
    if (!localStream) await startMicrophone();
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(track => track.enabled = micEnabled);
    updateMicButton();
  } catch (error) {
    handleMicError(error);
  }
}

function handleMicError(error) {
  console.error("Microfone:", error);
  if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
    showToast("Permissão do microfone bloqueada. Clique no cadeado da barra de endereço e permita o microfone.");
  } else if (error?.name === "NotFoundError") {
    showToast("Nenhum microfone foi encontrado neste dispositivo.");
  } else {
    showToast("Não foi possível acessar o microfone.");
  }
  updateMicButton();
}

function updateMicButton() {
  micBtn.innerHTML = micEnabled ? "🎤 <span>Microfone ligado</span>" : "🔇 <span>Microfone desligado</span>";
  micBtn.classList.toggle("active", micEnabled);
}

micBtn.onclick = toggleMic;

screenBtn.onclick = async () => {
  if (screenStream) {
    await stopScreen();
    return;
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    showToast("Seu navegador não permite compartilhamento de tela neste contexto.");
    return;
  }

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: "motion" },
      // Captura também o áudio da aba/sistema quando o navegador oferecer essa opção.
      audio: true
    });

    const track = screenStream.getVideoTracks()[0];
    if (!track) throw new Error("Nenhuma faixa de vídeo foi disponibilizada.");

    await updateOutgoingAudio();

    screenBtn.innerHTML = "⏹️ <span>Parar compartilhamento</span>";
    screenBtn.classList.add("active");
    socket.emit("screen-state", { sharing: true });

    const replacePromises = [];
    for (const { videoSender } of peers.values()) {
      if (videoSender) replacePromises.push(videoSender.replaceTrack(track));
    }
    await Promise.all(replacePromises);

    track.onended = () => stopScreen();
  } catch (error) {
    console.error("Compartilhamento de tela:", error);
    screenStream = null;

    if (error?.name === "NotAllowedError" || error?.name === "AbortError") {
      showToast("Compartilhamento cancelado ou não autorizado.");
    } else {
      showToast("Não foi possível iniciar o compartilhamento de tela.");
    }
  }
};

async function stopScreen() {
  if (!screenStream) return;

  const oldStream = screenStream;
  screenStream = null;
  oldStream.getTracks().forEach(track => track.stop());

  screenBtn.innerHTML = "🖥️ <span>Compartilhar tela</span>";
  screenBtn.classList.remove("active");
  socket.emit("screen-state", { sharing: false });

  const replacePromises = [];
  for (const { videoSender } of peers.values()) {
    if (videoSender) replacePromises.push(videoSender.replaceTrack(null));
  }
  await Promise.allSettled(replacePromises);
  await updateOutgoingAudio();
};

function renderRemoteStream(id, stream, name) {
  let wrap = document.getElementById(`screen-${id}`);

  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "screen-wrap";
    wrap.id = `screen-${id}`;

    const viewer = document.createElement("div");
    viewer.className = "video-viewer";

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.controls = false;
    video.className = "remote-screen-video";
    video.id = `video-${id}`;

    const actions = document.createElement("div");
    actions.className = "video-actions";

    const soundButton = document.createElement("button");
    soundButton.className = "video-action";
    soundButton.type = "button";
    soundButton.textContent = "🔊 Ativar áudio";
    soundButton.onclick = async () => {
      audioUnlocked = true;
      video.muted = false;
      try {
        await video.play();
        soundButton.textContent = "🔊 Áudio ativo";
        showToast("Áudio da transmissão ativado.");
      } catch {
        showToast("Toque novamente para liberar o áudio.");
      }
      if (audioBtn) {
        audioBtn.textContent = "🔊 Áudio ativado";
        audioBtn.classList.add("active");
      }
    };

    const fullscreenButton = document.createElement("button");
    fullscreenButton.className = "video-action";
    fullscreenButton.type = "button";
    fullscreenButton.textContent = "⛶ Tela cheia";
    fullscreenButton.onclick = () => requestFullscreenVideo(video);

    actions.append(soundButton, fullscreenButton);
    viewer.append(video, actions);

    const label = document.createElement("div");
    label.className = "screen-name";
    label.textContent = name;

    wrap.append(viewer, label);
    screensEl.appendChild(wrap);
  }

  const video = document.getElementById(`video-${id}`);
  if (video.srcObject !== stream) video.srcObject = stream;

  // Keep audio enabled. Mobile browsers may still require one user gesture;
  // the visible "Ativar áudio" button provides that gesture.
  video.muted = false;
  video.play().catch(() => {
    if (audioBtn) {
      audioBtn.textContent = "🔊 Ativar áudio";
      audioBtn.classList.remove("active");
    }
  });

  updateEmptyStage();
}
screensEl.addEventListener("click", () => {
  // A tap inside the transmission is also a valid user gesture on mobile.
  if (!audioUnlocked) unlockRemoteAudio();
});

copyBtn.onclick = async () => {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    showToast("Link da sala copiado!");
  } catch {
    prompt("Copie o link da sala:", url);
  }
};

leaveBtn.onclick = async () => {
  await stopScreen();
  peers.forEach(({ pc }) => pc.close());
  peers.clear();
  remoteStreams.clear();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  localStream = null;
  socket.emit("leave-room");
  location.href = "/";
};

window.addEventListener("beforeunload", () => {
  socket.emit("leave-room");
});
