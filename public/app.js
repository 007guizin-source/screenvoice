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
const remoteAudioElements = new Map();
const remoteTrackAudios = new Map();
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
  if (!code) return setError("Digite o cÃ³digo da sala.");
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
      setError(result?.error || "NÃ£o foi possÃ­vel entrar.");
      statusEl.textContent = "NÃ£o conectado";
      return;
    }

    home.classList.add("hidden");
    roomEl.classList.remove("hidden");
    roomCodeLabel.textContent = result.roomId;
    setError("");
    renderPeople(result.users.concat([{ socketId: socket.id, name: myName }]));

    try {
      // Request and enable the microphone immediately when entering the room.
      // The browser may show its permission prompt the first time.
      await startMicrophone();
      micEnabled = true;
      updateMicButton();
      statusEl.textContent = "Conectado â€” microfone ativo";
    } catch (error) {
      statusEl.textContent = "Conectado â€” microfone bloqueado";
      handleMicError(error);
    }

    // Somente os usuÃ¡rios que jÃ¡ estavam na sala iniciam a negociaÃ§Ã£o.
    // O usuÃ¡rio novo apenas espera os offers, evitando colisÃµes WebRTC.
    for (const user of result.users) {
      createPeer(user.socketId, user.name, false);
    }
  });
}

async function startMicrophone() {
  if (localStream) return localStream;

  if (!navigator.mediaDevices?.getUserMedia) {
    const error = new Error("getUserMedia nÃ£o estÃ¡ disponÃ­vel neste navegador/contexto.");
    error.name = "NotSupportedError";
    throw error;
  }

  const preferredAudio = {
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
    sampleRate: 48000,
    sampleSize: 16
  };

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: preferredAudio,
      video: false
    });
  } catch (error) {
    // Some mobile browsers reject advanced constraints. Fall back to a
    // simple microphone request instead of leaving the user without audio.
    console.warn("Fallback do microfone:", error);
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    });
  }

  const micTrack = localStream.getAudioTracks()[0];
  if (micTrack) {
    micTrack.enabled = true;
    micTrack.contentHint = "speech";
  }

  micEnabled = true;
  updateMicButton();
  updateOutgoingAudio();
  return localStream;
}


function updateOutgoingAudio() {
  for (const peer of peers.values()) {
    if (peer.micSender) {
      const micTrack = localStream?.getAudioTracks()[0] || null;
      peer.micSender.replaceTrack(micTrack).catch(error =>
        console.warn("Faixa do microfone:", error)
      );
    }
    if (peer.screenAudioSender) {
      const screenTrack = screenStream?.getAudioTracks()[0] || null;
      peer.screenAudioSender.replaceTrack(screenTrack).catch(error =>
        console.warn("Faixa de Ã¡udio da tela:", error)
      );
    }
  }
}

function awaitSafeSetSenderParameters(sender, params) {
  if (typeof sender.setParameters === "function") {
    return sender.setParameters(params).catch(error => {
      console.warn("setParameters:", error);
    });
  }
  return Promise.resolve();
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

  // Reserve uma faixa de vÃ­deo desde o inÃ­cio. Assim, compartilhar/parar a tela
  // usa replaceTrack() e nÃ£o precisa de uma nova negociaÃ§Ã£o.
  const videoTransceiver = pc.addTransceiver("video", { direction: "sendrecv" });
  peer.videoSender = videoTransceiver.sender;

  const micTransceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
  peer.micTransceiver = micTransceiver;
  peer.micSender = micTransceiver.sender;

  const screenAudioTransceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
  peer.screenAudioTransceiver = screenAudioTransceiver;
  peer.screenAudioSender = screenAudioTransceiver.sender;

  // Prioriza Opus, que Ã© o codec de Ã¡udio de maior qualidade/eficiÃªncia
  // suportado pelos navegadores modernos. Evita que o navegador escolha
  // codecs de telefonia de baixa qualidade quando houver alternativa.
  try {
    const codecs = RTCRtpReceiver.getCapabilities("audio")?.codecs || [];
    const opus = codecs.filter(codec =>
      /opus/i.test(codec.mimeType || "") && !/red|cn|telephone-event/i.test(codec.mimeType || "")
    );
    const others = codecs.filter(codec =>
      !/opus|red|cn|telephone-event/i.test(codec.mimeType || "")
    );
    if (opus.length && typeof pc.getTransceivers === "function") {
      micTransceiver.setCodecPreferences?.([...opus, ...others]);
      screenAudioTransceiver.setCodecPreferences?.([...opus, ...others]);
    }
  } catch (error) {
    console.warn("NÃ£o foi possÃ­vel priorizar Opus:", error);
  }

  // Give the microphone enough Opus bitrate for clear speech and avoid
  // aggressive low-quality voice encoding when the connection allows it.
  try {
    const params = micTransceiver.sender.getParameters();
    params.encodings = params.encodings?.length ? params.encodings : [{}];
    params.encodings[0].maxBitrate = 64000;
    params.encodings[0].networkPriority = "high";
    awaitSafeSetSenderParameters(micTransceiver.sender, params);
  } catch (error) {
    console.warn("NÃ£o foi possÃ­vel ajustar a qualidade do microfone:", error);
  }

  updateOutgoingAudio();

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

    if (event.track.kind === "audio") {
      setupRemoteAudioTrack(remoteId, peer, event.track, event.transceiver);
    }

    event.track.onended = () => {
      stream.removeTrack(event.track);
      removeRemoteAudioTrack(remoteId, event.track.id);
      renderRemoteStream(remoteId, stream, peer.remoteName);

      if (stream.getTracks().length === 0) {
        remoteStreams.delete(remoteId);
        remoteAudioElements.delete(remoteId);
        destroyRemoteAudioMixer(remoteId);
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
  // Quem jÃ¡ estava na sala inicia a conexÃ£o com quem acabou de entrar.
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
      console.warn("NÃ£o foi possÃ­vel adicionar ICE:", error);
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
    showToast(`${name || "AlguÃ©m"} comeÃ§ou a compartilhar a tela.`);
  }
});

function updateEmptyStage() { try { updateScreenStage(); } catch (_) {} }`r`n`r`nfunction removePeer(id) {
  const peer = peers.get(id);
  if (peer) {
    peer.pc.close();
    peers.delete(id);
  }
  remoteStreams.delete(id);
  remoteAudioElements.delete(id);
  destroyRemoteAudioMixer(id);
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
      <span class="person-name">${escapeHtml(user.name)}${user.socketId === socket.id ? " (vocÃª)" : ""}</span>
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
  let played = 0;

  const audios = document.querySelectorAll('audio.remote-screen-audio, audio.remote-screen-audio, audio');

  for (const audio of audios) {
    try {
      audio.autoplay = true;
      audio.muted = false;
      audio.volume = 0.75;
      await audio.play();
      played++;
    } catch (error) {
      console.warn("Áudio remoto ainda bloqueado:", error);
    }
  }

  for (const trackMap of remoteTrackAudios.values()) {
    for (const item of trackMap.values()) {
      try {
        if (!item.audio) continue;

        item.audio.autoplay = true;
        item.audio.muted = false;
        item.audio.volume = 0.75;

        await item.audio.play();
        played++;
      } catch (error) {
        console.warn("Não foi possível reproduzir áudio remoto:", error);
      }
    }
  }

  if (audioBtn) {
    const active = played > 0;
    audioBtn.textContent = active ? "🔊 Áudio ativado" : "🔊 Ativar áudio";
    audioBtn.classList.toggle("active", active);
  }

  if (played > 0) {
    showToast("Áudio ativado.");
  } else {
    showToast("Nenhum áudio disponível ainda. Tente novamente quando a outra pessoa falar.");
  }

  return played > 0;
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

    showToast("Tela cheia nÃ£o Ã© suportada por este navegador.");
  } catch (error) {
    console.warn("Tela cheia:", error);
    showToast("Toque novamente no botÃ£o de tela cheia.");
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
    showToast("PermissÃ£o do microfone bloqueada. Clique no cadeado da barra de endereÃ§o e permita o microfone.");
  } else if (error?.name === "NotFoundError") {
    showToast("Nenhum microfone foi encontrado neste dispositivo.");
  } else {
    showToast("NÃ£o foi possÃ­vel acessar o microfone.");
  }
  updateMicButton();
}

function updateMicButton() {
  micBtn.innerHTML = micEnabled ? "ðŸŽ¤ <span>Microfone ligado</span>" : "ðŸ”‡ <span>Microfone desligado</span>";
  micBtn.classList.toggle("active", micEnabled);
}

micBtn.onclick = toggleMic;

screenBtn.onclick = async () => {
  if (screenStream) {
    await stopScreen();
    return;
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    showToast("Seu navegador nÃ£o permite compartilhamento de tela neste contexto.");
    return;
  }

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: "motion", frameRate: { ideal: 30, max: 60 } },
      // Pede Ã¡udio de alta fidelidade. O navegador pode ignorar parte dessas
      // opÃ§Ãµes, mas quando suportadas elas evitam processamento desnecessÃ¡rio.
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: 48000,
        sampleSize: 16
      }
    });

    const track = screenStream.getVideoTracks()[0];
    if (!track) throw new Error("Nenhuma faixa de vÃ­deo foi disponibilizada.");

    const audioTracks = screenStream.getAudioTracks();
    if (audioTracks.length) {
      showToast("Ãudio da tela capturado.");
    } else {
      showToast("Tela sem Ã¡udio. No Chrome, selecione uma aba e marque 'Compartilhar Ã¡udio' ou 'Compartilhar Ã¡udio do sistema'.");
    }

    updateOutgoingAudio();

    screenBtn.innerHTML = "â¹ï¸ <span>Parar compartilhamento</span>";
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
      showToast("Compartilhamento cancelado ou nÃ£o autorizado.");
    } else {
      showToast("NÃ£o foi possÃ­vel iniciar o compartilhamento de tela.");
    }
  }
};

async function stopScreen() {
  if (!screenStream) return;

  const oldStream = screenStream;
  screenStream = null;
  oldStream.getTracks().forEach(track => track.stop());

  screenBtn.innerHTML = "ðŸ–¥ï¸ <span>Compartilhar tela</span>";
  screenBtn.classList.remove("active");
  socket.emit("screen-state", { sharing: false });

  const replacePromises = [];
  for (const { videoSender } of peers.values()) {
    if (videoSender) replacePromises.push(videoSender.replaceTrack(null));
  }
  await Promise.allSettled(replacePromises);
  await updateOutgoingAudio();
};

function getRemoteAudioType(peer, transceiver, existingTypes) {
  const mid = transceiver?.mid;
  if (mid && peer?.screenAudioTransceiver?.mid === mid) return "screen";
  if (mid && peer?.micTransceiver?.mid === mid) return "mic";
  return existingTypes.includes("mic") ? "screen" : "mic";
}

function setupRemoteAudioTrack(id, peer, track, transceiver) {
  if (track.kind !== "audio") return;

  let trackMap = remoteTrackAudios.get(id);
  if (!trackMap) {
    trackMap = new Map();
    remoteTrackAudios.set(id, trackMap);
  }
  if (trackMap.has(track.id)) return;

  const type = getRemoteAudioType(peer, transceiver, [...trackMap.values()].map(x => x.type));
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.controls = false;
  audio.muted = false;
  audio.playsInline = true;
  audio.setAttribute("playsinline", "");
  audio.className = "remote-track-audio";
  audio.volume = type === "screen" ? 0.45 : 1.0;
  audio.srcObject = new MediaStream([track]);
  audio.style.position = "fixed";
  audio.style.width = "1px";
  audio.style.height = "1px";
  audio.style.opacity = "0";
  audio.style.pointerEvents = "none";

  document.body.appendChild(audio);
  trackMap.set(track.id, { audio, type });

  if (audioUnlocked) {
    audio.play().catch(error => console.warn("ReproduÃ§Ã£o de faixa remota:", error));
  }
}

function removeRemoteAudioTrack(id, trackId) {
  const trackMap = remoteTrackAudios.get(id);
  if (!trackMap) return;
  const item = trackMap.get(trackId);
  if (!item) return;

  try {
    item.audio.pause();
    item.audio.srcObject = null;
    item.audio.remove();
  } catch {}
  trackMap.delete(trackId);
  if (!trackMap.size) remoteTrackAudios.delete(id);
}

function destroyRemoteAudioMixer(id) {
  const trackMap = remoteTrackAudios.get(id);
  if (!trackMap) return;
  for (const item of trackMap.values()) {
    try {
      item.audio.pause();
      item.audio.srcObject = null;
      item.audio.remove();
    } catch {}
  }
  remoteTrackAudios.delete(id);
}

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
    video.muted = true;
    video.className = "remote-screen-video";
    video.id = `video-${id}`;

    const actions = document.createElement("div");
    actions.className = "video-actions";

    const soundButton = document.createElement("button");
    soundButton.className = "video-action";
    soundButton.type = "button";
    soundButton.textContent = "ðŸ”Š Ativar Ã¡udio";
    soundButton.onclick = async event => {
      event.stopPropagation();
      await unlockRemoteAudio();
    };

    const fullscreenButton = document.createElement("button");
    fullscreenButton.className = "video-action";
    fullscreenButton.type = "button";
    fullscreenButton.textContent = "â›¶ Tela cheia";
    fullscreenButton.onclick = event => {
      event.stopPropagation();
      requestFullscreenVideo(video);
    };

    actions.append(soundButton, fullscreenButton);
    viewer.append(video, actions);

    const label = document.createElement("div");
    label.className = "screen-name";
    label.textContent = name;

    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.controls = false;
    audio.muted = !audioUnlocked;
    audio.volume = 1;
    audio.className = "remote-screen-audio";
    audio.id = `audio-${id}`;

    wrap.append(viewer, label, audio);
    screensEl.appendChild(wrap);
    remoteAudioElements.set(id, audio);
  }

  const video = document.getElementById(`video-${id}`);
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    const videoStream = new MediaStream([videoTrack]);
    if (!video.srcObject || video.srcObject.getVideoTracks()[0]?.id !== videoTrack.id) {
      video.srcObject = videoStream;
    }
    video.muted = true;
    video.play().catch(() => {});
  } else {
    video.srcObject = null;
  }
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
  for (const id of [...remoteAudioMixers.keys()]) destroyRemoteAudioMixer(id);
  remoteAudioElements.clear();
  remoteStreams.clear();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  localStream = null;
  socket.emit("leave-room");
  location.href = "/";
};

window.addEventListener("beforeunload", () => {
  socket.emit("leave-room");
});



