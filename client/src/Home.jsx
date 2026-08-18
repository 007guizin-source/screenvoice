import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

function generateRoomCode() {
  // Sem caracteres ambíguos (0/O, 1/I)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export default function Home() {
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  function handleCreateRoom() {
    if (!name.trim()) {
      setError('Digite seu nome primeiro.');
      return;
    }
    const code = generateRoomCode();
    navigate(`/room/${code}`, { state: { name: name.trim() } });
  }

  function handleJoinRoom() {
    if (!name.trim()) {
      setError('Digite seu nome primeiro.');
      return;
    }
    if (!joinCode.trim()) {
      setError('Digite o código da sala.');
      return;
    }
    navigate(`/room/${joinCode.trim().toUpperCase()}`, { state: { name: name.trim() } });
  }

  return (
    <div className="home">
      <div className="home-card">
        <h1>🎙️ Sala Rápida</h1>
        <p className="subtitle">Áudio e compartilhamento de tela. Sem cadastro, sem enrolação.</p>

        <label htmlFor="name">Nome</label>
        <input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Digite seu nome"
          autoFocus
        />

        <button className="btn primary" onClick={handleCreateRoom}>
          Criar sala
        </button>

        <div className="divider">
          <span>ou</span>
        </div>

        <label htmlFor="join">Código da sala</label>
        <div className="join-row">
          <input
            id="join"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            placeholder="Ex: X7K92P"
            maxLength={12}
          />
          <button className="btn secondary" onClick={handleJoinRoom}>
            Entrar
          </button>
        </div>

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
