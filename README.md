# ScreenVoice

Sala de áudio e compartilhamento de tela usando Node.js, Express, Socket.IO e WebRTC.

## Rodar localmente

```bash
npm install
npm start
```

Abra `http://localhost:3000`.

## Deploy no Render

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`

O projeto já possui `render.yaml`.

## Observações WebRTC

O aplicativo usa um servidor STUN público do Google. Isso funciona em muitas redes, mas algumas redes/NATs exigem um servidor TURN para conexão WebRTC confiável.
