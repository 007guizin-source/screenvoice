const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));

app.get("/room/:roomId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("*splat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function normalizeRoomId(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 32);
}

function roomUsers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return [...room.values()].map(({ socketId, name }) => ({ socketId, name }));
}

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, name }, callback) => {
    roomId = normalizeRoomId(roomId);
    name = String(name || "Convidado").trim().slice(0, 30) || "Convidado";

    if (!roomId) {
      callback?.({ ok: false, error: "Código da sala inválido." });
      return;
    }

    if (socket.data.roomId) {
      leaveCurrentRoom(socket);
    }

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const room = rooms.get(roomId);

    if (room.size >= 8) {
      callback?.({ ok: false, error: "Esta sala já está cheia (máximo de 8 pessoas)." });
      return;
    }

    const existingUsers = roomUsers(roomId);

    room.set(socket.id, { socketId: socket.id, name });
    socket.data.roomId = roomId;
    socket.data.name = name;
    socket.join(roomId);

    callback?.({ ok: true, roomId, users: existingUsers });

    socket.to(roomId).emit("user-joined", {
      socketId: socket.id,
      name
    });

    io.to(roomId).emit("room-users", roomUsers(roomId));
  });

  socket.on("signal", ({ to, data }) => {
    if (!to || !socket.data.roomId) return;
    io.to(to).emit("signal", {
      from: socket.id,
      data
    });
  });

  socket.on("screen-state", ({ sharing }) => {
    if (!socket.data.roomId) return;
    socket.to(socket.data.roomId).emit("screen-state", {
      socketId: socket.id,
      name: socket.data.name,
      sharing: Boolean(sharing)
    });
  });

  socket.on("leave-room", () => leaveCurrentRoom(socket));

  socket.on("disconnect", () => leaveCurrentRoom(socket));
});

function leaveCurrentRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (room) {
    room.delete(socket.id);
    socket.to(roomId).emit("user-left", { socketId: socket.id });
    io.to(roomId).emit("room-users", roomUsers(roomId));
    if (room.size === 0) rooms.delete(roomId);
  }

  socket.leave(roomId);
  socket.data.roomId = null;
}

server.listen(PORT, () => {
  console.log(`ScreenVoice rodando em http://localhost:${PORT}`);
});