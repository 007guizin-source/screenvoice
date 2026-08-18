import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';
import { ICE_SERVERS } from './webrtc.js';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

export default function Room() {
  const { roomId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const initialName = location.state?.name || '';

  const [name, setName] = useState(initialName);
  const [nameInput, setNameInput] = useState('');
  const [joined, setJoined] = useState(Boolean(initialName));

  const [micOn, setMicOn] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [participants, setParticipants] = useState({}); // id -> { name, micOn, sharing }
  const [remoteStreams, setRemoteStreams] = useState({}); // id -> { audio, video }
  const [connectionError, setConnectionError] = useState('');
  const [mediaError, setMediaError] = useState('');
  const [audioBlocked, setAudioBlocked] = useState(false);
  const audioElsRef = useRef({}); // peerId -> <audio> element, pra destravar depois

  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const peerConnectionsRef = useRef({}); // id -> RTCPeerConnection

  const updateRemoteStream = useCallback((peerId, kind, stream) => {
    setRemoteStreams((prev) => ({
      ...prev,
      [peerId]: { ...prev[peerId], [kind]: stream },
    }));
  }, []);

  const removeRemoteStream = useCallback((peerId) => {
    setRemoteStreams((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  }, []);

  const createPeerConnection = useCallback(
    (peerId) => {
      const pc = new RTCPeerConnection(ICE_SERVERS);
      pc._readyForRenegotiation = false;
      pc._iceQueue = [];
      pc._isOfferer = false; // marcado true externamente para quem inicia a oferta

      // Manda o áudio local (e a tela, se já estiver compartilhando).
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

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socketRef.current?.emit('signal', {
            to: peerId,
            data: { type: 'ice', candidate: event.candidate },
          });
        }
      };

      pc.ontrack = (event) => {
        const track = event.track;
        const stream = new MediaStream([track]);
        updateRemoteStream(peerId, track.kind, stream);
      };

      pc.onconnectionstatechange = () => {
        setParticipants((prev) => {
          if (!prev[peerId]) return prev;
          return { ...prev, [peerId]: { ...prev[peerId], connState: pc.connectionState } };
        });

        // Conexão caiu mas o socket ainda existe: tenta recuperar via ICE
        // restart antes de desistir. Cobre trocas de rede (Wi-Fi -> 4G) e
        // falhas de NAT que aparecem só depois de alguns segundos.
        if (pc.connectionState === 'failed') {
          restartIce(peerId, pc);
        }
      };

      // Renegociação (ex: alguém começa a compartilhar tela DEPOIS da
      // conexão inicial já estabelecida). Ignorado durante o setup inicial,
      // que é feito manualmente abaixo.
      pc.onnegotiationneeded = async () => {
        if (!pc._readyForRenegotiation) return;
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socketRef.current?.emit('signal', {
            to: peerId,
            data: { type: 'offer', sdp: pc.localDescription },
          });
        } catch (err) {
          console.error('Erro na renegociação:', err);
        }
      };

      peerConnectionsRef.current[peerId] = pc;
      return pc;
    },
    [updateRemoteStream]
  );

  const restartIce = useCallback(async (peerId, pc) => {
    // Só o lado que originalmente ofertou reinicia, pra não gerar glare
    // (os dois lados criando oferta ao mesmo tempo pro mesmo restart).
    if (!pc._readyForRenegotiation || !pc._isOfferer) return;
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      socketRef.current?.emit('signal', {
        to: peerId,
        data: { type: 'offer', sdp: pc.localDescription },
      });
    } catch (err) {
      console.error('Erro no ICE restart:', err);
    }
  }, []);

  const flushIceQueue = async (pc) => {
    if (!pc._iceQueue?.length) return;
    for (const candidate of pc._iceQueue) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('Erro ao aplicar ICE candidate em fila:', err);
      }
    }
    pc._iceQueue = [];
  };

  const closePeer = useCallback((peerId) => {
    const pc = peerConnectionsRef.current[peerId];
    if (pc) {
      pc.close();
      delete peerConnectionsRef.current[peerId];
    }
    removeRemoteStream(peerId);
    setParticipants((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  }, [removeRemoteStream]);

  useEffect(() => {
    if (!joined) return;

    let cancelled = false;

    async function setup() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        localStreamRef.current = stream;
      } catch (err) {
        setMediaError(
          'Não foi possível acessar o microfone. Verifique as permissões do navegador.'
        );
        return;
      }

      const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
      socketRef.current = socket;

      socket.on('connect_error', () => {
        setConnectionError('Não foi possível conectar ao servidor de sinalização.');
      });

      socket.on('connect', () => {
        setConnectionError('');
        socket.emit('join-room', { roomId, name });
      });

      // Nós somos os recém-chegados: iniciamos a oferta para cada peer existente.
      socket.on('existing-users', (users) => {
        const initial = {};
        users.forEach((u) => {
          initial[u.id] = { name: u.name, micOn: u.micOn, sharing: u.sharing };
        });
        setParticipants((prev) => ({ ...prev, ...initial }));

        users.forEach(async (u) => {
          const pc = createPeerConnection(u.id);
          pc._isOfferer = true;
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('signal', {
              to: u.id,
              data: { type: 'offer', sdp: pc.localDescription },
            });
          } catch (err) {
            console.error('Erro ao criar oferta:', err);
          }
        });
      });

      // Alguém novo entrou: só aguardamos a oferta dele.
      socket.on('user-joined', (user) => {
        setParticipants((prev) => ({
          ...prev,
          [user.id]: { name: user.name, micOn: user.micOn, sharing: user.sharing },
        }));
        createPeerConnection(user.id);
      });

      socket.on('signal', async ({ from, data }) => {
        let pc = peerConnectionsRef.current[from];
        if (!pc) {
          pc = createPeerConnection(from);
        }

        if (data.type === 'offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          await flushIceQueue(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          pc._readyForRenegotiation = true;
          socket.emit('signal', {
            to: from,
            data: { type: 'answer', sdp: pc.localDescription },
          });
        } else if (data.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          await flushIceQueue(pc);
          pc._readyForRenegotiation = true;
        } else if (data.type === 'ice') {
          if (pc.remoteDescription && pc.remoteDescription.type) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (err) {
              console.error('Erro ao adicionar ICE candidate:', err);
            }
          } else {
            pc._iceQueue.push(data.candidate);
          }
        }
      });

      socket.on('mic-toggled', ({ id, micOn: remoteMicOn }) => {
        setParticipants((prev) => ({
          ...prev,
          [id]: { ...prev[id], micOn: remoteMicOn },
        }));
      });

      socket.on('screen-share-started', ({ id }) => {
        setParticipants((prev) => ({
          ...prev,
          [id]: { ...prev[id], sharing: true },
        }));
      });

      socket.on('screen-share-stopped', ({ id }) => {
        setParticipants((prev) => ({
          ...prev,
          [id]: { ...prev[id], sharing: false },
        }));
        updateRemoteStream(id, 'video', null);
      });

      socket.on('user-left', ({ id }) => {
        closePeer(id);
      });
    }

    setup();

    return () => {
      cancelled = true;
      socketRef.current?.emit('leave-room');
      socketRef.current?.disconnect();
      Object.values(peerConnectionsRef.current).forEach((pc) => pc.close());
      peerConnectionsRef.current = {};
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, roomId, name]);

  function handleJoinSubmit(e) {
    e.preventDefault();
    if (!nameInput.trim()) return;
    setName(nameInput.trim());
    setJoined(true);
  }

  function toggleMic() {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
    socketRef.current?.emit('toggle-mic', { micOn: track.enabled });
  }

  async function startScreenShare() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      screenStreamRef.current = stream;
      const track = stream.getVideoTracks()[0];

      track.onended = () => {
        stopScreenShare();
      };

      Object.values(peerConnectionsRef.current).forEach((pc) => {
        pc.addTrack(track, stream);
      });

      socketRef.current?.emit('screen-share-started');
      setSharing(true);
    } catch (err) {
      // Usuário cancelou o picker ou negou permissão — não é um erro fatal.
      console.warn('Compartilhamento de tela cancelado:', err);
    }
  }

  function stopScreenShare() {
    const stream = screenStreamRef.current;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];

    Object.values(peerConnectionsRef.current).forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track === track);
      if (sender) pc.removeTrack(sender);
    });

    stream.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    socketRef.current?.emit('screen-share-stopped');
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
      alert('Link copiado: ' + link);
    } catch {
      prompt('Copie o link da sala:', link);
    }
  }

  function leaveRoom() {
    navigate('/');
  }

  function unlockAudio() {
    Object.values(audioElsRef.current).forEach((el) => {
      el.play().catch(() => {});
    });
    setAudioBlocked(false);
  }

  // --- Tela de entrada (quando alguém abre o link direto, sem passar pela Home) ---
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
          <button className="btn secondary" onClick={() => navigate('/')}>
            Voltar
          </button>
        </div>
      </div>
    );
  }

  const sharingPeerId = Object.entries(participants).find(([, p]) => p.sharing)?.[0];
  const remoteSharingStream = sharingPeerId ? remoteStreams[sharingPeerId]?.video : null;

  return (
    <div className="room">
      <header className="room-header">
        <span>SALA: {roomId}</span>
        {connectionError && <span className="error">{connectionError}</span>}
      </header>

      {audioBlocked && (
        <div className="audio-banner" onClick={unlockAudio}>
          🔇 O navegador bloqueou o áudio automático — toque aqui para ativar
        </div>
      )}

      <div className="screen-area">
        {sharing ? (
          <video
            className="screen-video"
            autoPlay
            playsInline
            muted
            ref={(el) => {
              if (el && screenStreamRef.current) el.srcObject = screenStreamRef.current;
            }}
          />
        ) : remoteSharingStream ? (
          <video
            className="screen-video"
            autoPlay
            playsInline
            ref={(el) => {
              if (el) el.srcObject = remoteSharingStream;
            }}
          />
        ) : (
          <p className="no-share">Ninguém está compartilhando a tela.</p>
        )}
      </div>

      <div className="participants">
        <div className="participant">
          <span>👤 {name} (você)</span>
          <span>{micOn ? '🎤' : '🔇'}</span>
        </div>
        {Object.entries(participants).map(([id, p]) => (
          <div className="participant" key={id}>
            <span>
              {p.connState === 'connecting' || p.connState === 'new' ? '🟡' : ''}
              {p.connState === 'connected' ? '🟢' : ''}
              {p.connState === 'failed' || p.connState === 'disconnected' ? '🔴' : ''}
              {' '}
              👤 {p.name}
            </span>
            <span>{p.micOn ? '🎤' : '🔇'}</span>
            {remoteStreams[id]?.audio && (
              <audio
                autoPlay
                playsInline
                ref={(el) => {
                  if (!el) return;
                  audioElsRef.current[id] = el;
                  if (el.srcObject !== remoteStreams[id].audio) {
                    el.srcObject = remoteStreams[id].audio;
                  }
                  const playPromise = el.play();
                  if (playPromise) {
                    playPromise.catch(() => setAudioBlocked(true));
                  }
                }}
              />
            )}
          </div>
        ))}
      </div>

      <div className="controls">
        <button className={`btn ${micOn ? 'secondary' : 'danger'}`} onClick={toggleMic}>
          {micOn ? '🎤 Microfone' : '🔇 Microfone'}
        </button>
        <button className={`btn ${sharing ? 'danger' : 'secondary'}`} onClick={toggleScreenShare}>
          {sharing ? '🖥 Parar compartilhamento' : '🖥 Compartilhar tela'}
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
