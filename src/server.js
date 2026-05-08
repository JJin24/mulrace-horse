const path = require("node:path");
const fastify = require("fastify");
const fastifyStatic = require("@fastify/static");
const { Server } = require("socket.io");
const dotenv = require("dotenv");
const { createDatabase } = require("./db");

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const OFFICIAL_ACCESS_KEY = process.env.OFFICIAL_ACCESS_KEY || "official-1234";
const BRIDGE_ACCESS_KEY = process.env.BRIDGE_ACCESS_KEY || "bridge-1234";
const MAX_FRAME_RATE = Number(process.env.MAX_FRAME_RATE || 15);
const COMMAND_MIN_INTERVAL_MS = Number(process.env.COMMAND_MIN_INTERVAL_MS || 80);

const ROLE_AUDIENCE = "audience";
const ROLE_OFFICIAL = "official";
const ROLE_BRIDGE = "bridge";

function isOfficial(socket) {
  return socket.data.role === ROLE_OFFICIAL;
}

function isAudience(socket) {
  return socket.data.role === ROLE_AUDIENCE;
}

function isBridge(socket) {
  return socket.data.role === ROLE_BRIDGE;
}

async function buildServer() {
  const db = createDatabase(path.join(__dirname, "..", "data", "app.db"));
  await db.init();

  const app = fastify({
    logger: true,
    bodyLimit: 2 * 1024 * 1024
  });

  await app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "public"),
    prefix: "/"
  });

  const io = new Server(app.server, {
    transports: ["websocket"],
    perMessageDeflate: false,
    maxHttpBufferSize: 2 * 1024 * 1024
  });

  const runtime = {
    raceState: await db.getRaceState(),
    activePoll: await db.getActivePoll(),
    droneRegistry: new Map(),
    socketVotes: new Map(),
    lastCommandAt: new Map()
  };

  if (runtime.activePoll) {
    runtime.socketVotes.set(String(runtime.activePoll.id), new Set());
  }

  function getAudienceCount() {
    return io.sockets.adapter.rooms.get(ROLE_AUDIENCE)?.size || 0;
  }

  function getDronesPayload() {
    return Array.from(runtime.droneRegistry.values())
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((drone) => ({
        id: drone.id,
        label: drone.label,
        lastSeen: drone.lastSeen,
        state: drone.state || {},
        online: Date.now() - drone.lastSeen < 8_000
      }));
  }

  async function getSnapshotPayload() {
    return {
      raceState: runtime.raceState,
      horses: await db.getHorses(),
      activePoll: runtime.activePoll,
      drones: getDronesPayload(),
      audienceCount: getAudienceCount()
    };
  }

  async function broadcastHorses() {
    io.emit("horses:update", await db.getHorses());
  }

  function publishAudienceCount() {
    io.emit("audience:count", getAudienceCount());
  }

  app.get("/", async (_, reply) => reply.sendFile("index.html"));

  app.get("/official", async (_, reply) => reply.sendFile("official.html"));

  app.get("/audience", async (_, reply) => reply.sendFile("audience.html"));

  app.get("/health", async () => ({
    ok: true,
    at: new Date().toISOString()
  }));

  app.get("/api/state", async () => getSnapshotPayload());

  app.get("/api/horses", async () => db.getHorses());

  app.post("/api/horses", async (request, reply) => {
    try {
      const horse = await db.createHorse(request.body || {});
      await broadcastHorses();
      return horse;
    } catch (error) {
      reply.code(400);
      return { error: error.message };
    }
  });

  app.put("/api/horses/:id", async (request, reply) => {
    try {
      const horse = await db.updateHorse(request.params.id, request.body || {});
      await broadcastHorses();
      return horse;
    } catch (error) {
      reply.code(400);
      return { error: error.message };
    }
  });

  app.delete("/api/horses/:id", async (request, reply) => {
    const removed = await db.removeHorse(request.params.id);
    if (!removed) {
      reply.code(404);
      return { error: "Horse not found." };
    }
    await broadcastHorses();
    return { ok: true };
  });

  io.on("connection", (socket) => {
    socket.data.role = "guest";

    socket.on("audience:join", async () => {
      socket.data.role = ROLE_AUDIENCE;
      socket.join(ROLE_AUDIENCE);
      publishAudienceCount();
      socket.emit("state:snapshot", await getSnapshotPayload());
    });

    socket.on("official:auth", async (payload = {}) => {
      const providedKey = String(payload.accessKey || "");
      if (providedKey !== OFFICIAL_ACCESS_KEY) {
        socket.emit("official:auth:result", { ok: false, error: "Invalid access key." });
        return;
      }
      socket.data.role = ROLE_OFFICIAL;
      socket.join(ROLE_OFFICIAL);
      socket.emit("official:auth:result", { ok: true });
      socket.emit("state:snapshot", await getSnapshotPayload());
    });

    socket.on("bridge:register", (payload = {}) => {
      const providedKey = String(payload.bridgeKey || "");
      if (providedKey !== BRIDGE_ACCESS_KEY) {
        socket.emit("bridge:register:result", { ok: false, error: "Invalid bridge key." });
        return;
      }
      const drones = Array.isArray(payload.drones) ? payload.drones : [];
      socket.data.role = ROLE_BRIDGE;
      socket.join(ROLE_BRIDGE);
      socket.data.droneIds = drones
        .map((drone) => String(drone.id || "").trim())
        .filter((id) => id.length > 0);

      for (const drone of drones) {
        const droneId = String(drone.id || "").trim();
        if (!droneId) {
          continue;
        }
        runtime.droneRegistry.set(droneId, {
          id: droneId,
          label: String(drone.label || droneId),
          bridgeSocketId: socket.id,
          lastSeen: Date.now(),
          lastFrameAt: 0,
          state: {}
        });
      }
      io.emit("drones:update", getDronesPayload());
      socket.emit("bridge:register:result", { ok: true });
    });

    socket.on("bridge:frame", (payload = {}) => {
      if (!isBridge(socket)) {
        return;
      }
      const droneId = String(payload.droneId || "");
      const frame = String(payload.frame || "");
      const drone = runtime.droneRegistry.get(droneId);
      if (!drone || drone.bridgeSocketId !== socket.id || !frame) {
        return;
      }

      const now = Date.now();
      const minFrameInterval = Math.max(1, Math.floor(1000 / MAX_FRAME_RATE));
      if (now - drone.lastFrameAt < minFrameInterval) {
        return;
      }

      drone.lastFrameAt = now;
      drone.lastSeen = now;

      const framePayload = {
        droneId,
        frame,
        timestamp: Number(payload.timestamp || now)
      };
      io.to(ROLE_AUDIENCE).emit("stream:frame", framePayload);
      io.to(ROLE_OFFICIAL).emit("stream:frame", framePayload);
    });

    socket.on("bridge:state", (payload = {}) => {
      if (!isBridge(socket)) {
        return;
      }
      const droneId = String(payload.droneId || "");
      const drone = runtime.droneRegistry.get(droneId);
      if (!drone || drone.bridgeSocketId !== socket.id) {
        return;
      }
      drone.lastSeen = Date.now();
      drone.state = payload.state || {};
      io.emit("drone:state", {
        droneId,
        state: drone.state,
        lastSeen: drone.lastSeen
      });
    });

    socket.on("drone:command", (payload = {}) => {
      if (!isOfficial(socket)) {
        return;
      }
      const now = Date.now();
      const previous = runtime.lastCommandAt.get(socket.id) || 0;
      if (now - previous < COMMAND_MIN_INTERVAL_MS) {
        return;
      }
      runtime.lastCommandAt.set(socket.id, now);

      const droneId = String(payload.droneId || "");
      const command = String(payload.command || "");
      if (!droneId || !command) {
        return;
      }
      io.to(ROLE_BRIDGE).emit("drone:command", {
        droneId,
        command,
        ...payload
      });
    });

    socket.on("race:update", async (payload = {}) => {
      if (!isOfficial(socket)) {
        return;
      }
      const status = String(payload.status || "idle");
      const lap = Number(payload.lap || 0);
      if (!["idle", "ready", "running", "paused", "finished"].includes(status)) {
        socket.emit("race:error", { error: "Invalid race status." });
        return;
      }
      if (!Number.isInteger(lap) || lap < 0) {
        socket.emit("race:error", { error: "Invalid lap number." });
        return;
      }
      runtime.raceState = await db.setRaceState(status, lap);
      io.emit("race:update", runtime.raceState);
    });

    socket.on("poll:create", async (payload = {}) => {
      if (!isOfficial(socket)) {
        return;
      }
      try {
        await db.closeActivePoll();
        const created = await db.createPoll(payload.question, payload.options || []);
        runtime.activePoll = created;
        runtime.socketVotes.set(String(created.id), new Set());
        io.emit("poll:update", created);
      } catch (error) {
        socket.emit("poll:error", { error: error.message });
      }
    });

    socket.on("poll:close", async () => {
      if (!isOfficial(socket)) {
        return;
      }
      const closed = await db.closeActivePoll();
      runtime.activePoll = null;
      if (closed) {
        io.emit("poll:update", closed);
      } else {
        io.emit("poll:update", null);
      }
    });

    socket.on("poll:vote", async (payload = {}) => {
      if (!isAudience(socket)) {
        return;
      }
      if (!runtime.activePoll || runtime.activePoll.status !== "active") {
        socket.emit("vote:rejected", { error: "No active poll available." });
        return;
      }
      const pollId = runtime.activePoll.id;
      const optionKey = String(payload.optionKey || "");
      if (!optionKey) {
        socket.emit("vote:rejected", { error: "Option is required." });
        return;
      }

      const pollVoteKey = String(pollId);
      if (!runtime.socketVotes.has(pollVoteKey)) {
        runtime.socketVotes.set(pollVoteKey, new Set());
      }
      const votedSockets = runtime.socketVotes.get(pollVoteKey);
      if (votedSockets.has(socket.id)) {
        socket.emit("vote:rejected", { error: "You already voted in this round." });
        return;
      }

      try {
        runtime.activePoll = await db.vote(pollId, optionKey);
        votedSockets.add(socket.id);
        io.emit("poll:update", runtime.activePoll);
        socket.emit("vote:accepted", { pollId, optionKey });
      } catch (error) {
        socket.emit("vote:rejected", { error: error.message });
      }
    });

    socket.on("disconnect", () => {
      runtime.lastCommandAt.delete(socket.id);
      if (isAudience(socket)) {
        publishAudienceCount();
      }
      if (isBridge(socket)) {
        for (const droneId of socket.data.droneIds || []) {
          const drone = runtime.droneRegistry.get(droneId);
          if (drone && drone.bridgeSocketId === socket.id) {
            runtime.droneRegistry.delete(droneId);
          }
        }
        io.emit("drones:update", getDronesPayload());
      }
    });
  });

  app.addHook("onClose", async () => {
    await db.close();
  });

  return { app };
}

async function start() {
  const { app } = await buildServer();
  await app.listen({ port: PORT, host: HOST });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
