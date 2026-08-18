// STUN do Google + TURN público gratuito (Open Relay Project) como fallback.
// O TURN é o que resolve conexão em redes com NAT simétrico/CGNAT (4G,
// corporativas) onde P2P direto via STUN falha. É um serviço público de
// terceiros com capacidade limitada — para um app em produção real, o ideal
// é trocar por um TURN próprio (ex: Twilio, Cloudflare, ou coturn hospedado).
export const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};
