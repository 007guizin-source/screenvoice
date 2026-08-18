const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// Estado 100% em memória. Sem banco de dados, sem persistência.
// roomId -> Map<socketId, { name, micOn, sharing }>
const rooms = new Map();

function getRoomUsers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.entries()).map(([id, data]) => ({ id, ...data }));
}

function removeUserFromRoom(socket, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.delete(socket.id);
  if (room.size === 0) {
    rooms.delete(roomId);
  }
  socket.to(roomId).emit('user-left', { id: socket.id });
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ roomId, name }) => {
    if (!roomId || !name) return;
    const cleanRoomId = String(roomId).trim().toUpperCase();
    const cleanName = String(name).trim().slice(0, 40);
    if (!cleanRoomId || !cleanName) return;

    currentRoom = cleanRoomId;
    socket.join(cleanRoomId);

    if (!rooms.has(cleanRoomId)) rooms.set(cleanRoomId, new Map());
    const room = rooms.get(cleanRoomId);

    // Manda pro recém-chegado a lista de quem já está na sala.
    // O recém-chegado será quem inicia a oferta WebRTC para cada um deles.
    const existingUsers = getRoomUsers(cleanRoomId);
    socket.emit('existing-users', existingUsers);

    const userData = { name: cleanName, micOn: true, sharing: false };
    room.set(socket.id, userData);

    socket.to(cleanRoomId).emit('user-joined', { id: socket.id, ...userData });
  });

  // Relay puro de sinalização WebRTC (offer / answer / ICE candidates).
  // O servidor nunca olha o conteúdo, só encaminha.
  socket.on('signal', ({ to, data }) => {
    if (!to || !data) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('toggle-mic', ({ micOn }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room && room.has(socket.id)) {
      room.get(socket.id).micOn = !!micOn;
    }
    socket.to(currentRoom).emit('mic-toggled', { id: socket.id, micOn: !!micOn });
  });

  socket.on('screen-share-started', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room && room.has(socket.id)) room.get(socket.id).sharing = true;
    socket.to(currentRoom).emit('screen-share-started', { id: socket.id });
  });

  socket.on('screen-share-stopped', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room && room.has(socket.id)) room.get(socket.id).sharing = false;
    socket.to(currentRoom).emit('screen-share-stopped', { id: socket.id });
  });

  socket.on('leave-room', () => {
    if (!currentRoom) return;
    removeUserFromRoom(socket, currentRoom);
    socket.leave(currentRoom);
    currentRoom = null;
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    removeUserFromRoom(socket, currentRoom);
  });
});

// Serve o build do client em produção, se existir (deploy como um único serviço).
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Servidor de sinalização rodando na porta ${PORT}`);
});
