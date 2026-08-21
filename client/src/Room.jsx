import './Room-volume.css';
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { io } from "socket.io-client";
import { ICE_SERVERS } from "./webrtc.js";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || window.location.origin;

export default function Room() {
  const { roomId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const initialName = location.state?.name || "";

  const [name, setName] = useState(initialName);
  const [nameInput, setNameInput] = useState("");
  const [joined, setJoined] = useState(Boolean(initialName));
  const [micOn, setMicOn] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [participants, setParticipants] = useState({});
  const [remoteStreams, setRemoteStreams] = useState({});
  const [connectionError, setConnectionError] = useState("");
  const [mediaError, setMediaError] = useState("");
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const peerConnectionsRef = useRef({});
  const remoteStreamsRef = useRef({});
  const remoteAudioElementsRef = useRef({});
  const remoteAudioContextsRef = useRef({});
  const remoteGainNodesRef = useRef({});
  const [remoteVolumes, setRemoteVolumes] = useState({});

  const remoteVideoRef = useRef(null);
  const localVideoRef = useRef(null);
  const screenAreaRef = useRef(null);


  const setRemoteTrack = useCallback((peerId, track) => {
    let stream = remoteStreamsRef.current[peerId];

    if (!stream) {
      stream = new MediaStream();
      remoteStreamsRef.current[peerId] = stream;
    }

    if (!stream.getTracks().some((t) => t.id === track.id)) {
      stream.addTrack(track);
    }

    setRemoteStreams((prev) => ({
      ...prev,
      [peerId]: stream
    }));
  }, []);

  const removeRemotePeer = useCallback((peerId) => {
    remoteStreamsRef.current[peerId]?.getTracks().forEach((track) => track.stop());
    delete remoteStreamsRef.current[peerId];

    setRemoteStreams((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  }, []);

  const createPeerConnection = useCallback(
    (peerId) => {
      if (peerConnectionsRef.current[peerId]) {
        return peerConnectionsRef.current[peerId];
      }

      const socket = socketRef.current;
      const pc = new RTCPeerConnection(ICE_SERVERS);

      // Perfect Negotiation: um lado é "polite" para evitar colisões
      // quando os dois lados adicionam/removem tracks ao mesmo tempo.
      pc.polite = socket ? socket.id > peerId : false;
      pc.makingOffer = false;
      pc.ignoreOffer = false;

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          pc.addTrack(track, localStreamRef.current);
        });
      }

      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((track) => {
          pc.addTrack(track, screenStreamRef.current);
        });
      }

      // Mantém o áudio de voz estável: evita DTX (que pode soar como
      // cortes em algumas combinações de microfone/rede) e dá ao Opus
      // largura de banda suficiente para voz com qualidade.
      pc.getSenders()
        .filter((sender) => sender.track?.kind === "audio")
        .forEach((sender) => {
          try {
            const params = sender.getParameters();
            if (!params.encodings?.length) return;

            params.encodings = params.encodings.map((encoding) => ({
              ...encoding,
              maxBitrate: 40000,
              dtx: false
            }));

            sender.setParameters(params).catch((err) => {
              console.debug("Não foi possível ajustar o áudio Opus:", err);
            });
          } catch (err) {
            console.debug("Não foi possível ajustar os parâmetros de áudio:", err);
          }
        });

      pc.onicecandidate = ({ candidate }) => {
        if (!candidate) return;

        socketRef.current?.emit("signal", {
          to: peerId,
          data: {
            type: "ice",
            candidate
          }
        });
      };

      pc.ontrack = ({ track }) => {
        setRemoteTrack(peerId, track);

        track.onended = () => {
          const stream = remoteStreamsRef.current[peerId];
          if (!stream) return;

          stream.removeTrack(track);

          setRemoteStreams((prev) => ({
            ...prev,
            [peerId]: stream
          }));
        };
      };

      pc.onconnectionstatechange = () => {
        setParticipants((prev) => {
          if (!prev[peerId]) return prev;

          return {
            ...prev,
            [peerId]: {
              ...prev[peerId],
              connState: pc.connectionState
            }
          };
        });
      };

      pc.onnegotiationneeded = async () => {
        try {
          pc.makingOffer = true;

          await pc.setLocalDescription();

          socketRef.current?.emit("signal", {
            to: peerId,
            data: {
              type: "offer",
              sdp: pc.localDescription
            }
          });
        } catch (err) {
          console.error("Falha na negociação WebRTC:", err);
        } finally {
          pc.makingOffer = false;
        }
      };

      peerConnectionsRef.current[peerId] = pc;
      return pc;
    },
    [setRemoteTrack]
  );

  const closePeer = useCallback(
    (peerId) => {
      if (!peerId) return;

      const pc = peerConnectionsRef.current[peerId];

      if (pc) {
        pc.ontrack = null;
        pc.close();
        delete peerConnectionsRef.current[peerId];
      }

      removeRemotePeer(peerId);

      setParticipants((prev) => {
        const next = { ...prev };
        delete next[peerId];
        return next;
      });

      delete remoteAudioElementsRef.current[peerId];

      remoteGainNodesRef.current[peerId]?.disconnect();
      delete remoteGainNodesRef.current[peerId];

      const audioContext = remoteAudioContextsRef.current[peerId];
      if (audioContext) {
        audioContext.close().catch(() => {});
        delete remoteAudioContextsRef.current[peerId];
      }

      setRemoteVolumes((prev) => {
        const next = { ...prev };
        delete next[peerId];
        return next;
      });
    },
    [removeRemotePeer]
  );

  // A transmissão de vídeo é detectada pelo track recebido de fato.
  // Isso evita a tela ficar vazia se o evento "screen-state" chegar
  // antes/depois da renegociação WebRTC.
  const remoteSharingEntry = Object.entries(remoteStreams).find(
    ([, stream]) =>
      stream.getVideoTracks().some((track) => track.readyState !== "ended")
  );

  const remoteSharingStream = remoteSharingEntry?.[1] || null;

  useEffect(() => {
    const video = remoteVideoRef.current;
    if (!video) return;

    // O elemento de vídeo recebe SOMENTE o track de vídeo.
    // O áudio da transmissão (e a voz) fica nos elementos <audio>,
    // evitando que o áudio do compartilhamento seja perdido/duplicado.
    const videoOnlyStream = remoteSharingStream
      ? new MediaStream(remoteSharingStream.getVideoTracks())
      : null;

    video.srcObject = videoOnlyStream;

    if (videoOnlyStream) {
      video.play().catch(() => {});
    }

    return () => {
      if (video.srcObject === videoOnlyStream) {
        video.pause();
        video.srcObject = null;
      }
    };
  }, [remoteSharingStream]);

  useEffect(() => {
    const video = localVideoRef.current;
    if (!video) return;

    video.srcObject = sharing ? screenStreamRef.current || null : null;

    if (sharing && screenStreamRef.current) {
      video.play().catch(() => {});
    }
  }, [sharing]);

  useEffect(() => {
    if (!joined) return;

    let cancelled = false;

    async function setup() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            // Mantém cancelamento de eco, mas evita o processamento
            // agressivo que pode cortar sílabas/começos de palavras.
            echoCancellation: true,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1,
            sampleRate: 48000,
            sampleSize: 16,
            latency: 0.01
          }
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        localStreamRef.current = stream;

        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) {
          console.log("Microfone ativo:", audioTrack.getSettings());
        }
      } catch (err) {
        console.error(err);
        setMediaError(
          "Não foi possível acessar o microfone. Verifique as permissões do navegador."
        );
        return;
      }

      const socket = io(SERVER_URL, {
        transports: ["websocket", "polling"],
        withCredentials: true
      });

      socketRef.current = socket;

      socket.on("connect_error", (err) => {
        console.error("Socket.IO:", err);
        setConnectionError(
          "Não foi possível conectar ao servidor de sinalização."
        );
      });

      socket.on("connect", () => {
        setConnectionError("");

        socket.emit("join-room", { roomId, name }, (response) => {
          if (!response?.ok) {
            setConnectionError(
              response?.error || "Não foi possível entrar na sala."
            );
            return;
          }

          const users = response.users || [];
          const initial = {};

          users.forEach((user) => {
            const id = user.id || user.socketId;
            if (!id) return;

            initial[id] = {
              name: user.name,
              micOn: user.micOn !== false,
              sharing: Boolean(user.sharing)
            };
          });

          setParticipants(initial);

          users.forEach((user) => {
            const id = user.id || user.socketId;
            if (id) createPeerConnection(id);
          });
        });
      });

      socket.on("user-joined", (user) => {
        const id = user.id || user.socketId;
        if (!id) return;

        setParticipants((prev) => ({
          ...prev,
          [id]: {
            name: user.name,
            micOn: user.micOn !== false,
            sharing: Boolean(user.sharing)
          }
        }));

        createPeerConnection(id);
      });

      socket.on("room-users", (users) => {
        setParticipants((prev) => {
          const next = { ...prev };

          users.forEach((user) => {
            const id = user.id || user.socketId;
            if (!id || id === socket.id) return;

            next[id] = {
              ...next[id],
              name: user.name,
              micOn: user.micOn !== false,
              sharing: Boolean(user.sharing)
            };
          });

          return next;
        });
      });

      socket.on("signal", async ({ from, data }) => {
        if (!from || !data) return;

        const pc = createPeerConnection(from);

        try {
          if (data.type === "offer") {
            const offerCollision =
              pc.makingOffer || pc.signalingState !== "stable";

            pc.ignoreOffer = !pc.polite && offerCollision;

            if (pc.ignoreOffer) return;

            if (offerCollision) {
              await pc.setLocalDescription({ type: "rollback" });
            }

            await pc.setRemoteDescription(data.sdp);

            await pc.setLocalDescription(await pc.createAnswer());

            socket.emit("signal", {
              to: from,
              data: {
                type: "answer",
                sdp: pc.localDescription
              }
            });
          } else if (data.type === "answer") {
            await pc.setRemoteDescription(data.sdp);
          } else if (data.type === "ice") {
            try {
              await pc.addIceCandidate(data.candidate);
            } catch (err) {
              if (!pc.ignoreOffer) throw err;
            }
          }
        } catch (err) {
          console.error("Erro na sinalização WebRTC:", err);
        }
      });

      socket.on("mic-toggled", ({ id, micOn: remoteMicOn }) => {
        setParticipants((prev) => ({
          ...prev,
          [id]: {
            ...prev[id],
            micOn: Boolean(remoteMicOn)
          }
        }));
      });

      socket.on("screen-state", ({ id, sharing: remoteSharing }) => {
        setParticipants((prev) => ({
          ...prev,
          [id]: {
            ...prev[id],
            sharing: Boolean(remoteSharing)
          }
        }));
      });

      socket.on("user-left", ({ id, socketId }) => {
        closePeer(id || socketId);
      });
    }

    setup();

    return () => {
      cancelled = true;

      socketRef.current?.emit("leave-room");
      socketRef.current?.disconnect();
      socketRef.current = null;

      Object.values(peerConnectionsRef.current).forEach((pc) => pc.close());
      peerConnectionsRef.current = {};

      Object.values(remoteStreamsRef.current).forEach((stream) => {
        stream.getTracks().forEach((track) => track.stop());
      });
      remoteStreamsRef.current = {};

      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current?.getTracks().forEach((track) => track.stop());

      localStreamRef.current = null;
      screenStreamRef.current = null;
    };
  }, [joined, roomId, name, createPeerConnection, closePeer]);

  function handleJoinSubmit(e) {
    e.preventDefault();

    const cleanName = nameInput.trim();
    if (!cleanName) return;

    setName(cleanName);
    setJoined(true);
  }

  function toggleMic() {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;

    track.enabled = !track.enabled;
    setMicOn(track.enabled);

    socketRef.current?.emit("toggle-mic", {
      micOn: track.enabled
    });
  }

  async function startScreenShare() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: {
            ideal: 30,
            max: 60
          }
        },
        audio: true
      });

      screenStreamRef.current = stream;

      const videoTrack = stream.getVideoTracks()[0];

      if (videoTrack) {
        videoTrack.onended = () => stopScreenShare();
      }

      Object.values(peerConnectionsRef.current).forEach((pc) => {
        stream.getTracks().forEach((track) => {
          pc.addTrack(track, stream);
        });
      });

      // A renegociação será disparada automaticamente pelo WebRTC.
      socketRef.current?.emit("screen-state", {
        sharing: true
      });

      setSharing(true);
    } catch (err) {
      console.warn("Compartilhamento de tela cancelado:", err);
    }
  }

  function stopScreenShare() {
    const stream = screenStreamRef.current;
    if (!stream) return;

    const tracks = new Set(stream.getTracks());

    Object.values(peerConnectionsRef.current).forEach((pc) => {
      pc.getSenders().forEach((sender) => {
        if (sender.track && tracks.has(sender.track)) {
          try {
            pc.removeTrack(sender);
          } catch {
            // conexão já encerrada
          }
        }
      });
    });

    stream.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;

    socketRef.current?.emit("screen-state", {
      sharing: false
    });

    setSharing(false);
  }

  function toggleScreenShare() {
    if (sharing) {
      stopScreenShare();
    } else {
      startScreenShare();
    }
  }

  async function copyInvite() {
    const link = `${window.location.origin}/room/${roomId}`;

    try {
      await navigator.clipboard.writeText(link);
      alert("Link copiado: " + link);
    } catch {
      prompt("Copie o link da sala:", link);
    }
  }

  function leaveRoom() {
    socketRef.current?.emit("leave-room");
    navigate("/");
  }

  function setRemoteVolume(peerId, value) {
    const volume = Math.max(0, Math.min(2, Number(value)));

    setRemoteVolumes((prev) => ({
      ...prev,
      [peerId]: volume
    }));

    const gain = remoteGainNodesRef.current[peerId];
    if (gain) {
      gain.gain.value = volume;
      return;
    }

    const audio = remoteAudioElementsRef.current[peerId];
    if (audio) {
      audio.volume = Math.min(1, volume);
    }
  }

  async function unlockAudio() {
    await Promise.all(
      Object.values(remoteAudioContextsRef.current).map((context) =>
        context?.resume?.().catch?.(() => {})
      )
    );

    const elements = document.querySelectorAll("audio, video");
    await Promise.all(
      [...elements].map((element) => element.play().catch(() => {}))
    );

    setAudioBlocked(false);
  }

  async function toggleFullscreen() {
    const element = screenAreaRef.current;
    if (!element) return;

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await element.requestFullscreen();
      }
    } catch (err) {
      console.warn("Não foi possível abrir a transmissão em tela cheia:", err);
    }
  }

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === screenAreaRef.current);
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  if (!joined) {
    return (
      <div className="home">
        <div className="home-card">
          <h1>Entrar na sala</h1>
          <p className="subtitle">
            Sala: <strong>{roomId}</strong>
          </p>

          <form onSubmit={handleJoinSubmit}>
            <label htmlFor="name2">Nome</label>

            <input
              id="name2"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="Digite seu nome"
              autoFocus
            />

            <button className="btn primary" type="submit">
              Entrar
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (mediaError) {
    return (
      <div className="home">
        <div className="home-card">
          <h1>Ops</h1>
          <p className="error">{mediaError}</p>

          <button className="btn secondary" onClick={() => navigate("/")}>
            Voltar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="room">
      <header className="room-header">
        <span>SALA: {roomId}</span>

        {connectionError && (
          <span className="error">{connectionError}</span>
        )}
      </header>

      {audioBlocked && (
        <div className="audio-banner" onClick={unlockAudio}>
          🔇 O navegador bloqueou o áudio automático — toque aqui para ativar
        </div>
      )}

      <div
        ref={screenAreaRef}
        className="screen-area"
        onDoubleClick={toggleFullscreen}
        title="Duplo clique para tela cheia"
      >
        {sharing ? (
          <video
            ref={localVideoRef}
            className="screen-video"
            autoPlay
            playsInline
            muted
          />
        ) : remoteSharingStream?.getVideoTracks().length ? (
          <video
            ref={remoteVideoRef}
            className="screen-video"
            autoPlay
            playsInline
          />
        ) : (
          <p className="no-share">
            Ninguém está compartilhando a tela.
          </p>
        )}
      </div>

      {Object.entries(remoteStreams).map(([peerId, stream]) => {
        if (!stream.getAudioTracks().length) return null;

        const volume = remoteVolumes[peerId] ?? 1;
        const participantName = participants[peerId]?.name || "Convidado";

        return (
          <div className="remote-audio-control" key={`audio-${peerId}`}>
            <audio
              autoPlay
              playsInline
              ref={(element) => {
                if (!element) return;

                remoteAudioElementsRef.current[peerId] = element;
                element.srcObject = stream;

                try {
                  let audioContext = remoteAudioContextsRef.current[peerId];

                  if (!audioContext) {
                    audioContext = new AudioContext();

                    const source = audioContext.createMediaElementSource(element);
                    const gain = audioContext.createGain();

                    source.connect(gain);
                    gain.connect(audioContext.destination);

                    remoteAudioContextsRef.current[peerId] = audioContext;
                    remoteGainNodesRef.current[peerId] = gain;
                  }

                  remoteGainNodesRef.current[peerId].gain.value = volume;

                  if (audioContext.state === "suspended") {
                    audioContext.resume().catch(() => {});
                  }
                } catch (err) {
                  console.warn("Controle individual de volume indisponível:", err);
                  element.volume = Math.min(1, volume);
                }

                element.play().catch(() => {
                  setAudioBlocked(true);
                });
              }}
            />

            <div className="remote-volume-row">
              <span className="remote-volume-name">{participantName}</span>

              <button
                type="button"
                className="volume-btn"
                onClick={() => setRemoteVolume(peerId, volume - 0.1)}
                title="Diminuir volume"
              >
                −
              </button>

              <input
                type="range"
                min="0"
                max="2"
                step="0.05"
                value={volume}
                onChange={(e) => setRemoteVolume(peerId, e.target.value)}
                aria-label={`Volume de ${participantName}`}
              />

              <button
                type="button"
                className="volume-btn"
                onClick={() => setRemoteVolume(peerId, volume + 0.1)}
                title="Aumentar volume"
              >
                +
              </button>

              <span className="volume-value">
                {Math.round(volume * 100)}%
              </span>
            </div>
          </div>
        );
      })}

      <div className="participants">
        <div className="participant">
          👤 {name} ({micOn ? "voz" : "mudo"})
        </div>

        {Object.entries(participants).map(([id, participant]) => (
          <div className="participant" key={id}>
            👤 {participant.name || "Convidado"}{" "}
            {participant.micOn === false ? "🔇" : "🎙️"}
            {participant.sharing ? " 🖥️" : ""}
          </div>
        ))}
      </div>

      <div className="controls">
        <button className="btn secondary" onClick={toggleMic}>
          🎤 {micOn ? "Microfone" : "Ativar microfone"}
        </button>

        <button
          className="btn secondary"
          onClick={toggleScreenShare}
        >
          🖥️{" "}
          {sharing
            ? "Parar de compartilhar"
            : "Compartilhar tela"}
        </button>

        <button
          className="btn secondary"
          onClick={toggleFullscreen}
          disabled={!sharing && !remoteSharingStream}
          title={!sharing && !remoteSharingStream ? "Nenhuma transmissão ativa" : "Abrir transmissão em tela cheia"}
        >
          {isFullscreen ? "⛶ Sair da tela cheia" : "⛶ Tela cheia"}
        </button>

        <button className="btn secondary" onClick={copyInvite}>
          🔗 Copiar convite
        </button>

        <button className="btn danger" onClick={leaveRoom}>
          🚪 Sair
        </button>
      </div>
    </div>
  );
}
