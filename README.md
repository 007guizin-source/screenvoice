# Sala Rápida

MVP de sala de áudio + compartilhamento de tela via WebRTC. Sem login, sem banco de dados, sem histórico. Entrar → conversar → compartilhar tela → sair.

## Rodando localmente

```bash
npm install
npm run dev
```

Isso sobe o backend (porta 3001) e o frontend (porta 5173) juntos. Abra **http://localhost:5173**.

Se preferir rodar cada um separado:

```bash
# terminal 1
cd server && npm install && npm run dev

# terminal 2
cd client && npm install && npm run dev
```

## Como testar (2 pessoas)

1. Abra `http://localhost:5173`, digite um nome, clique em **Criar sala**.
2. Copie o link da sala (botão 🔗) — algo como `http://localhost:5173/room/X7K92P`.
3. Abra esse link numa **aba anônima** ou em outro navegador, digite outro nome, entre.
4. As duas abas devem ouvir o microfone uma da outra automaticamente (aceite a permissão do navegador).
5. Clique em **Compartilhar tela** numa das abas e escolha o que compartilhar.
6. A outra aba deve mostrar a tela compartilhada no centro.
7. Clique em **Parar compartilhamento** (ou pare pela barra nativa do navegador) — o vídeo deve sumir dos dois lados.
8. Clique em **Sair** — a outra aba deve remover o participante da lista.

Teste real entre duas redes diferentes (não só duas abas no mesmo Wi-Fi) antes de considerar validado — é aí que problemas de NAT aparecem.

## O que foi resolvido em relação à primeira versão

- **TURN de fallback**: além do STUN, agora usa um TURN público gratuito (Open Relay Project). Isso cobre a maioria dos casos de NAT simétrico/CGNAT (redes móveis, corporativas) onde conexão P2P direta falha. É um serviço público de terceiros com capacidade limitada — não é garantia de 100% de conexões, e não deve ser usado como TURN definitivo em produção com tráfego real (ver abaixo).
- **ICE restart automático**: se a conexão cair (troca de rede, Wi-Fi instável), o lado que originou a chamada tenta reconectar sozinho.
- **Indicador de status por participante**: 🟡 conectando, 🟢 conectado, 🔴 falhou — para você saber se o problema é áudio mudo ou conexão que nunca fechou.
- **Cancelamento de eco/ruído/ganho automático** no microfone — sem isso, quem usa caixa de som (em vez de fone) causa eco pros outros.
- **Detecção de autoplay bloqueado**: alguns navegadores bloqueiam áudio automático até haver interação do usuário — antes isso parecia "a pessoa entrou mas não tem som"; agora aparece um banner pra destravar com um toque.

## Limitações que continuam existindo (sem enrolação)

- **TURN público tem capacidade limitada.** Em uso real com várias pessoas simultâneas, ele pode ficar lento ou recusar conexão. Para produção séria, troque as credenciais em `client/src/webrtc.js` por um TURN próprio (Cloudflare Calls, Twilio, Metered.ca pago, ou coturn autohospedado).
- **Arquitetura mesh (P2P todos-com-todos)**: cada pessoa manda áudio/tela direto pra cada outra pessoa da sala. Funciona bem para 2-4 pessoas. Com mais gente compartilhando tela ao mesmo tempo, o upload de quem compartilha cresce muito — não é um MVP pensado para salas grandes.
- **Sem persistência**: se o servidor reiniciar, todas as salas somem. É intencional (não pediram banco de dados), mas vale saber.

## Deploy

**Importante**: microfone e compartilhamento de tela só funcionam em **HTTPS** (ou `localhost`). Em produção, os dois — frontend e backend — precisam estar em domínios com certificado válido.

Caminho mais simples:

1. **Backend**: suba a pasta `server/` num serviço tipo Render, Railway ou Fly.io. Eles dão HTTPS automático. Anote a URL pública (ex: `https://seu-backend.onrender.com`).
2. **Frontend**: rode `npm run build -w client` e suba a pasta `client/dist` num serviço tipo Vercel ou Netlify. Antes do build, configure a variável de ambiente `VITE_SERVER_URL` apontando pro backend do passo 1.
3. Alternativa mais simples ainda: o `server.js` já serve os arquivos de `client/dist` se eles existirem (veja o fim do arquivo) — dá pra rodar tudo num serviço só (build do client antes do deploy do backend).

Sobre WebRTC em produção: STUN resolve boa parte das conexões; o TURN de fallback incluído cobre boa parte do resto, mas leia a seção de limitações acima antes de assumir que "sempre vai funcionar".
