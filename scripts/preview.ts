import { extname, join, normalize, relative } from "node:path";
import type { ServerWebSocket } from "bun";

const root = join(process.cwd(), "out");
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";
const fallbackLimit = Number(process.env.PORT_FALLBACK_LIMIT ?? 10);

type RoomPeer = {
  peerId: string;
  participantId: string;
  name: string;
  role: "host" | "guest";
};

type SocketData = {
  id: string;
  roomCode?: string;
  peer?: RoomPeer;
};

type SignalSocket = ServerWebSocket<SocketData>;

const rooms = new Map<string, Map<string, SignalSocket>>();

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

function isInsideRoot(pathname: string) {
  const rel = relative(root, pathname);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function createSocketId() {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function send(socket: SignalSocket, message: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(roomCode: string, message: unknown, exceptPeerId?: string) {
  const room = rooms.get(roomCode);
  if (!room) return;

  room.forEach((socket, peerId) => {
    if (peerId !== exceptPeerId) {
      send(socket, message);
    }
  });
}

function leaveRoom(socket: SignalSocket) {
  const { roomCode, peer } = socket.data;
  if (!roomCode || !peer) return;

  const room = rooms.get(roomCode);
  if (room?.get(peer.peerId) === socket) {
    room.delete(peer.peerId);
  }
  if (room?.size === 0) {
    rooms.delete(roomCode);
  }

  broadcast(roomCode, {
    type: "peer-left",
    roomCode,
    peerId: peer.peerId
  });

  socket.data.roomCode = undefined;
  socket.data.peer = undefined;
}

function replaceExistingSocket(roomCode: string, peerId: string, nextSocket: SignalSocket) {
  const room = rooms.get(roomCode);
  const existing = room?.get(peerId);
  if (existing && existing !== nextSocket) {
    existing.close(1000, "Replaced by a newer connection");
  }
}

async function existingFile(pathname: string) {
  const file = Bun.file(pathname);
  return (await file.exists()) ? file : null;
}

async function resolveFile(request: Request) {
  const url = new URL(request.url);
  const rawPath = decodeURIComponent(url.pathname);
  const normalized = normalize(rawPath).replace(/^(\.\.[/\\])+/, "");
  const candidate = join(root, normalized);

  if (!isInsideRoot(candidate)) {
    return null;
  }

  const direct = await existingFile(candidate);
  if (direct) {
    return direct;
  }

  const [, firstSegment, ...restSegments] = normalized.split("/");
  if (firstSegment && restSegments.length) {
    const withoutBasePath = join(root, restSegments.join("/"));
    if (isInsideRoot(withoutBasePath)) {
      const basePathFile = await existingFile(withoutBasePath);
      if (basePathFile) {
        return basePathFile;
      }
    }
  }

  const index = await existingFile(join(candidate, "index.html"));
  if (index) {
    return index;
  }

  if (!extname(candidate)) {
    return existingFile(join(root, "index.html"));
  }

  return null;
}

function serve(candidatePort: number) {
  const server = Bun.serve<SocketData>({
    hostname,
    port: candidatePort,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/ws" || url.pathname.endsWith("/ws")) {
        const upgraded = server.upgrade(request, {
          data: { id: createSocketId() }
        });
        if (upgraded) {
          return undefined;
        }
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      const file = await resolveFile(request);
      if (!file) {
        return new Response("Not found", { status: 404 });
      }

      return new Response(file, {
        headers: {
          "content-type": mimeTypes[extname(file.name ?? "")] ?? "application/octet-stream"
        }
      });
    },
    websocket: {
      open(socket) {
        socket.subscribe(socket.data.id);
      },
      message(socket, rawMessage) {
        let message: any;
        try {
          message = JSON.parse(String(rawMessage));
        } catch {
          send(socket, { type: "error", message: "Invalid JSON" });
          return;
        }

        if (message.type === "join") {
          const roomCode = String(message.roomCode ?? "").trim().toLowerCase();
          const peer = message.peer as RoomPeer | undefined;
          if (!roomCode || !peer?.peerId) {
            send(socket, { type: "error", message: "Invalid join" });
            return;
          }

          leaveRoom(socket);

          let room = rooms.get(roomCode);
          if (!room) {
            room = new Map();
            rooms.set(roomCode, room);
          }

          replaceExistingSocket(roomCode, peer.peerId, socket);

          const existingPeers = Array.from(room.values())
            .map((entry) => entry.data.peer)
            .filter((entryPeer) => entryPeer && entryPeer.peerId !== peer.peerId) as RoomPeer[];

          socket.data.roomCode = roomCode;
          socket.data.peer = peer;
          room.set(peer.peerId, socket);

          send(socket, {
            type: "joined",
            roomCode,
            peers: existingPeers
          });
          broadcast(
            roomCode,
            {
              type: "peer-joined",
              roomCode,
              peer
            },
            peer.peerId
          );
          return;
        }

        const roomCode = socket.data.roomCode;
        const peer = socket.data.peer;
        if (!roomCode || !peer) {
          send(socket, { type: "error", message: "Join a room first" });
          return;
        }

        if (message.type === "signal") {
          const target = rooms.get(roomCode)?.get(String(message.toPeerId ?? ""));
          if (!target) return;

          send(target, {
            type: "signal",
            roomCode,
            fromPeerId: peer.peerId,
            peer,
            signal: message.signal
          });
          return;
        }

        if (message.type === "profile") {
          const updatedPeer = message.peer as RoomPeer | undefined;
          if (!updatedPeer?.peerId || updatedPeer.peerId !== peer.peerId) {
            return;
          }

          socket.data.peer = updatedPeer;
          rooms.get(roomCode)?.set(updatedPeer.peerId, socket);
          broadcast(
            roomCode,
            {
              type: "peer-updated",
              roomCode,
              peer: updatedPeer
            },
            updatedPeer.peerId
          );
          return;
        }

        if (message.type === "ping") {
          send(socket, { type: "pong", time: Date.now() });
          return;
        }

        if (message.type === "leave") {
          leaveRoom(socket);
          return;
        }

        if (message.type === "chat") {
          broadcast(
            roomCode,
            {
              type: "chat",
              id: message.id,
              author: message.author,
              text: message.text,
              time: message.time,
              roomCode
            },
            peer.peerId
          );
        }
      },
      close(socket) {
        leaveRoom(socket);
      }
    }
  });

  return server;
}

let server: ReturnType<typeof Bun.serve> | null = null;
let selectedPort = port;

for (let offset = 0; offset <= fallbackLimit; offset += 1) {
  const candidatePort = port + offset;
  try {
    server = serve(candidatePort);
    selectedPort = candidatePort;
    break;
  } catch (error) {
    const isPortBusy =
      error instanceof Error &&
      ("code" in error || "message" in error) &&
      ((error as Error & { code?: string }).code === "EADDRINUSE" ||
        error.message.includes("EADDRINUSE"));

    if (!isPortBusy || offset === fallbackLimit) {
      throw error;
    }
  }
}

if (!server) {
  throw new Error("Не удалось запустить preview-сервер.");
}

if (selectedPort !== port) {
  console.warn(`Port ${port} is busy. Using ${selectedPort} instead.`);
}

console.log(`Serving ${root} at http://${hostname}:${selectedPort}/`);
