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


## Correções para celular
- Botão **Ativar áudio** para contornar a política de autoplay dos navegadores móveis.
- Cada transmissão tem botão **Tela cheia**, incluindo suporte ao fullscreen de vídeo do Safari/iPhone/iPad quando disponível.
- Os vídeos remotos usam `playsinline` e controles próprios, evitando que a reprodução fique presa em um comportamento incompatível com celular.
- O compartilhamento de tela continua dependente do suporte do navegador/dispositivo: em alguns celulares, principalmente iPhone/iPad, o navegador pode não permitir `getDisplayMedia`.
- Para microfone e compartilhamento de tela, o site precisa estar em HTTPS (o Render fornece HTTPS no endereço público).


## Microfone
O microfone é solicitado e ativado automaticamente ao entrar na sala. O navegador pode pedir permissão na primeira vez.
