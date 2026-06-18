"use client";

import {
  Camera,
  CameraOff,
  Check,
  Copy,
  Link,
  Loader2,
  MessageSquareText,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Plus,
  RefreshCw,
  ScreenShareOff,
  Send,
  Settings2,
  ShieldCheck,
  UserRound,
  UsersRound,
  Video,
  Wifi,
  WifiOff
} from "lucide-react";
import type { DataConnection, MediaConnection, Peer } from "peerjs";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  attachLocalMedia,
  createRtcConfig,
  getTrackLabel,
  PeerWiring,
  replaceSenderTrack,
  stopStream
} from "@/lib/webrtc";

type Role = "host" | "guest";
type Status = "booting" | "connecting" | "ready" | "reconnecting" | "error";
type Transport = "local" | "peerjs";

type Participant = {
  peerId: string;
  participantId: string;
  name: string;
  role: Role;
  connected: boolean;
  remoteStream: MediaStream | null;
};

type ChatMessage = {
  id: string;
  author: string;
  text: string;
  time: number;
  local?: boolean;
  system?: boolean;
};

type DeviceLists = {
  audioInputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
};

type RoomPeer = {
  peerId: string;
  participantId: string;
  name: string;
  role: Role;
};

type WireMessage =
  | {
      type: "hello";
      peer: RoomPeer;
      roomCode: string;
    }
  | {
      type: "roster";
      peers: RoomPeer[];
      roomCode: string;
    }
  | {
      type: "peer-joined";
      peer: RoomPeer;
      roomCode: string;
    }
  | {
      type: "peer-left";
      peerId: string;
      roomCode: string;
    }
  | {
      type: "chat";
      id: string;
      author: string;
      text: string;
      time: number;
      roomCode: string;
    };

type LocalSignalMessage =
  | {
      type: "joined";
      roomCode: string;
      peers: RoomPeer[];
    }
  | {
      type: "peer-joined";
      roomCode: string;
      peer: RoomPeer;
    }
  | {
      type: "peer-left";
      roomCode: string;
      peerId: string;
    }
  | {
      type: "signal";
      roomCode: string;
      fromPeerId: string;
      peer: RoomPeer;
      signal:
        | { kind: "description"; description: RTCSessionDescriptionInit }
        | { kind: "candidate"; candidate: RTCIceCandidateInit };
    }
  | {
      type: "chat";
      id: string;
      author: string;
      text: string;
      time: number;
      roomCode: string;
    };

type LocalPeerRuntime = {
  connection: RTCPeerConnection;
  wiring: PeerWiring;
};

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const ROOM_PARAM = "room";
const HOST_STORAGE_KEY = "online-call-host-room";
const NAME_STORAGE_KEY = "online-call-name";
const SIGNALING_WATCHDOG_MS = 25_000;

const peerOptions = {
  host: "0.peerjs.com",
  port: 443,
  path: "/",
  secure: true,
  debug: 1,
  pingInterval: 5000,
  config: {
    iceCandidatePoolSize: 4,
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:global.stun.twilio.com:3478" }
    ]
  }
};

function createId(length = 8) {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function createRoomCode() {
  return createId(6);
}

function sanitizeRoomCode(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 16);
}

function hostPeerId(roomCode: string) {
  return `onlinecall-${roomCode}-host`;
}

function guestPeerId(roomCode: string, participantId: string, nonce: string) {
  return `onlinecall-${roomCode}-${participantId}-${nonce}`;
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat("ru", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(value);
}

function statusText(status: Status, role: Role) {
  if (status === "ready") {
    return role === "host" ? "комната открыта" : "подключено";
  }
  if (status === "connecting") return "подключение";
  if (status === "reconnecting") return "переподключение";
  if (status === "error") return "ошибка";
  return "запуск";
}

function VideoElement({
  stream,
  muted
}: {
  stream: MediaStream | null;
  muted?: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) {
      ref.current.srcObject = stream;
    }
  }, [stream]);

  return <video ref={ref} autoPlay playsInline muted={muted} />;
}

export function MeetApp() {
  const [participantId] = useState(() => createId(8));
  const [displayName, setDisplayName] = useState("Гость");
  const [roomCode, setRoomCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [role, setRole] = useState<Role>("host");
  const [status, setStatus] = useState<Status>("booting");
  const [statusDetail, setStatusDetail] = useState("Подготовка комнаты");
  const [selfPeerId, setSelfPeerId] = useState("");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [devices, setDevices] = useState<DeviceLists>({ audioInputs: [], videoInputs: [] });
  const [audioDeviceId, setAudioDeviceId] = useState("");
  const [videoDeviceId, setVideoDeviceId] = useState("");
  const [chatText, setChatText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toast, setToast] = useState("");

  const transportRef = useRef<Transport | null>(null);
  const peerRef = useRef<Peer | null>(null);
  const localSocketRef = useRef<WebSocket | null>(null);
  const localPeersRef = useRef(new Map<string, LocalPeerRuntime>());
  const connectionsRef = useRef(new Map<string, DataConnection>());
  const mediaCallsRef = useRef(new Map<string, MediaConnection>());
  const participantsRef = useRef(participants);
  const localStreamRef = useRef(localStream);
  const screenStreamRef = useRef(screenStream);
  const roomCodeRef = useRef(roomCode);
  const roleRef = useRef(role);
  const selfPeerIdRef = useRef(selfPeerId);
  const displayNameRef = useRef(displayName);
  const reconnectTimerRef = useRef<number | null>(null);
  const openWatchdogTimerRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  useEffect(() => {
    screenStreamRef.current = screenStream;
  }, [screenStream]);

  useEffect(() => {
    roomCodeRef.current = roomCode;
  }, [roomCode]);

  useEffect(() => {
    roleRef.current = role;
  }, [role]);

  useEffect(() => {
    selfPeerIdRef.current = selfPeerId;
  }, [selfPeerId]);

  useEffect(() => {
    displayNameRef.current = displayName;
  }, [displayName]);

  const connectedCount = participants.filter((participant) => participant.connected).length;
  const hasLocalMedia = Boolean(localStream);
  const activeLocalStream = screenStream ?? localStream;

  const roomLink = useMemo(() => {
    if (typeof window === "undefined" || !roomCode) return "";
    const url = new URL(window.location.href);
    url.searchParams.set(ROOM_PARAM, roomCode);
    return url.toString();
  }, [roomCode]);

  const selfPeer = useCallback(
    (): RoomPeer => ({
      peerId: selfPeerIdRef.current,
      participantId,
      name: displayNameRef.current.trim() || "Гость",
      role: roleRef.current
    }),
    [participantId]
  );

  const showToast = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(""), 2400);
  }, []);

  const addSystemMessage = useCallback((text: string) => {
    setMessages((current) => [
      ...current,
      {
        id: createId(),
        author: "OnlineCall",
        text,
        time: Date.now(),
        system: true
      }
    ]);
  }, []);

  const updateRoomUrl = useCallback((nextRoomCode: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set(ROOM_PARAM, nextRoomCode);
    window.history.replaceState(null, "", url.toString());
  }, []);

  const setParticipant = useCallback((peer: RoomPeer, patch?: Partial<Participant>) => {
    if (!peer.peerId || peer.peerId === selfPeerIdRef.current) return;

    setParticipants((current) => {
      const existing = current.find((item) => item.peerId === peer.peerId);
      if (existing) {
        return current.map((item) =>
          item.peerId === peer.peerId
            ? {
                ...item,
                participantId: peer.participantId || item.participantId,
                name: peer.name || item.name,
                role: peer.role || item.role,
                connected: patch?.connected ?? item.connected,
                remoteStream: patch?.remoteStream ?? item.remoteStream
              }
            : item
        );
      }

      return [
        ...current,
        {
          peerId: peer.peerId,
          participantId: peer.participantId,
          name: peer.name || "Гость",
          role: peer.role,
          connected: patch?.connected ?? false,
          remoteStream: patch?.remoteStream ?? null
        }
      ];
    });
  }, []);

  const removeParticipant = useCallback((peerId: string) => {
    setParticipants((current) => current.filter((participant) => participant.peerId !== peerId));
  }, []);

  const setRemoteStream = useCallback((peerId: string, stream: MediaStream | null) => {
    setParticipants((current) =>
      current.map((participant) =>
        participant.peerId === peerId ? { ...participant, remoteStream: stream } : participant
      )
    );
  }, []);

  const closeMediaCall = useCallback(
    (peerId: string) => {
      const call = mediaCallsRef.current.get(peerId);
      if (call) {
        call.removeAllListeners();
        call.close();
      }
      mediaCallsRef.current.delete(peerId);
      setRemoteStream(peerId, null);
    },
    [setRemoteStream]
  );

  const closeLocalPeer = useCallback(
    (peerId: string) => {
      const runtime = localPeersRef.current.get(peerId);
      if (runtime) {
        runtime.connection.close();
      }
      localPeersRef.current.delete(peerId);
      setRemoteStream(peerId, null);
    },
    [setRemoteStream]
  );

  const closeDataConnection = useCallback(
    (peerId: string) => {
      const connection = connectionsRef.current.get(peerId);
      if (connection) {
        connection.removeAllListeners();
        connection.close();
      }
      connectionsRef.current.delete(peerId);
      closeMediaCall(peerId);
      closeLocalPeer(peerId);
      removeParticipant(peerId);
    },
    [closeLocalPeer, closeMediaCall, removeParticipant]
  );

  const cleanupPeer = useCallback(() => {
    if (reconnectTimerRef.current) {
      window.clearInterval(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (openWatchdogTimerRef.current) {
      window.clearTimeout(openWatchdogTimerRef.current);
      openWatchdogTimerRef.current = null;
    }
    if (retryTimerRef.current) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    connectionsRef.current.forEach((connection) => {
      connection.removeAllListeners();
      connection.close();
    });
    connectionsRef.current.clear();

    mediaCallsRef.current.forEach((call) => {
      call.removeAllListeners();
      call.close();
    });
    mediaCallsRef.current.clear();

    localSocketRef.current?.close();
    localSocketRef.current = null;
    localPeersRef.current.forEach((runtime, peerId) => {
      runtime.connection.close();
    });
    localPeersRef.current.clear();
    transportRef.current = null;

    peerRef.current?.removeAllListeners();
    peerRef.current?.destroy();
    peerRef.current = null;
    setParticipants([]);
  }, []);

  const sendToConnection = useCallback((connection: DataConnection, message: WireMessage) => {
    if (connection.open) {
      connection.send(message);
    }
  }, []);

  const broadcast = useCallback(
    (message: WireMessage, exceptPeerId?: string) => {
      connectionsRef.current.forEach((connection, peerId) => {
        if (peerId !== exceptPeerId) {
          sendToConnection(connection, message);
        }
      });
    },
    [sendToConnection]
  );

  const wireMediaCall = useCallback(
    (call: MediaConnection) => {
      mediaCallsRef.current.set(call.peer, call);
      call.on("stream", (stream) => {
        setRemoteStream(call.peer, stream);
      });
      call.on("close", () => {
        mediaCallsRef.current.delete(call.peer);
        setRemoteStream(call.peer, null);
      });
      call.on("error", () => {
        mediaCallsRef.current.delete(call.peer);
        setRemoteStream(call.peer, null);
      });
    },
    [setRemoteStream]
  );

  const activeSendStream = useCallback(() => {
    return screenStreamRef.current ?? localStreamRef.current;
  }, []);

  const sendLocalSignal = useCallback((message: Record<string, unknown>) => {
    const socket = localSocketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }, []);

  const updateLocalMediaTracks = useCallback(() => {
    const stream = activeSendStream();
    const audioTrack = stream?.getAudioTracks()[0] ?? null;
    const videoTrack = stream?.getVideoTracks()[0] ?? null;

    localPeersRef.current.forEach((runtime, peerId) => {
      void replaceSenderTrack(runtime.wiring.audioSender, audioTrack);
      void replaceSenderTrack(runtime.wiring.videoSender, videoTrack);
      void runtime.connection
        .createOffer()
        .then((description) => runtime.connection.setLocalDescription(description))
        .then(() => {
          if (!runtime.connection.localDescription) return;
          sendLocalSignal({
            type: "signal",
            roomCode: roomCodeRef.current,
            toPeerId: peerId,
            signal: {
              kind: "description",
              description: runtime.connection.localDescription.toJSON()
            }
          });
        });
    });
  }, [activeSendStream, sendLocalSignal]);

  const localSignalUrl = useCallback(() => {
    if (typeof window === "undefined") return null;
    if (window.location.hostname.endsWith("github.io")) return null;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${basePath}/ws`;
  }, []);

  const createLocalPeerConnection = useCallback(
    (remotePeer: RoomPeer, shouldOffer: boolean) => {
      if (!remotePeer.peerId || remotePeer.peerId === selfPeerIdRef.current) return null;

      const existing = localPeersRef.current.get(remotePeer.peerId);
      if (existing) {
        setParticipant(remotePeer, { connected: true });
        return existing;
      }

      const connection = new RTCPeerConnection(createRtcConfig("public-stun"));
      const wiring = attachLocalMedia(connection, activeSendStream());
      const runtime: LocalPeerRuntime = { connection, wiring };
      localPeersRef.current.set(remotePeer.peerId, runtime);
      setParticipant(remotePeer, { connected: true });

      connection.onicecandidate = (event) => {
        if (!event.candidate) return;
        sendLocalSignal({
          type: "signal",
          roomCode: roomCodeRef.current,
          toPeerId: remotePeer.peerId,
          signal: {
            kind: "candidate",
            candidate: event.candidate.toJSON()
          }
        });
      };

      connection.ontrack = (event) => {
        const [stream] = event.streams;
        setRemoteStream(remotePeer.peerId, stream ?? new MediaStream([event.track]));
      };

      connection.onconnectionstatechange = () => {
        if (connection.connectionState === "connected") {
          setParticipant(remotePeer, { connected: true });
          return;
        }

        if (
          connection.connectionState === "failed" ||
          connection.connectionState === "closed" ||
          connection.connectionState === "disconnected"
        ) {
          setParticipants((current) =>
            current.map((participant) =>
              participant.peerId === remotePeer.peerId
                ? { ...participant, connected: false, remoteStream: null }
                : participant
            )
          );
        }
      };

      if (shouldOffer) {
        void connection
          .createOffer()
          .then((description) => connection.setLocalDescription(description))
          .then(() => {
            if (!connection.localDescription) return;
            sendLocalSignal({
              type: "signal",
              roomCode: roomCodeRef.current,
              toPeerId: remotePeer.peerId,
              signal: {
                kind: "description",
                description: connection.localDescription.toJSON()
              }
            });
          });
      }

      return runtime;
    },
    [activeSendStream, sendLocalSignal, setParticipant, setRemoteStream]
  );

  const handleLocalSignalMessage = useCallback(
    async (message: LocalSignalMessage) => {
      if (message.roomCode !== roomCodeRef.current) return;

      if (message.type === "joined") {
        transportRef.current = "local";
        setStatus("ready");
        setStatusDetail(roleRef.current === "host" ? "Локальная комната открыта" : "Вы в локальной комнате");

        for (const peer of message.peers) {
          setParticipant(peer, { connected: true });
        }
        return;
      }

      if (message.type === "peer-joined") {
        setParticipant(message.peer, { connected: true });
        createLocalPeerConnection(message.peer, true);
        return;
      }

      if (message.type === "peer-left") {
        closeLocalPeer(message.peerId);
        removeParticipant(message.peerId);
        return;
      }

      if (message.type === "chat") {
        setMessages((current) => {
          if (current.some((item) => item.id === message.id)) return current;
          return [
            ...current,
            {
              id: message.id,
              author: message.author,
              text: message.text,
              time: message.time
            }
          ];
        });
        return;
      }

      if (message.type !== "signal") return;

      const runtime =
        localPeersRef.current.get(message.fromPeerId) ??
        createLocalPeerConnection(message.peer, false);
      if (!runtime) return;

      if (message.signal.kind === "description") {
        await runtime.connection.setRemoteDescription(message.signal.description);
        if (message.signal.description.type === "offer") {
          const answer = await runtime.connection.createAnswer();
          await runtime.connection.setLocalDescription(answer);
          if (runtime.connection.localDescription) {
            sendLocalSignal({
              type: "signal",
              roomCode: roomCodeRef.current,
              toPeerId: message.fromPeerId,
              signal: {
                kind: "description",
                description: runtime.connection.localDescription.toJSON()
              }
            });
          }
        }
        return;
      }

      await runtime.connection.addIceCandidate(message.signal.candidate);
    },
    [closeLocalPeer, createLocalPeerConnection, removeParticipant, sendLocalSignal, setParticipant]
  );

  const startLocalSignaling = useCallback(
    (nextRoomCode: string) => {
      const url = localSignalUrl();
      if (!url) return Promise.resolve(false);

      return new Promise<boolean>((resolve) => {
        let settled = false;
        const socket = new WebSocket(url);
        const timeout = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          socket.close();
          resolve(false);
        }, 1400);

        socket.onopen = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          localSocketRef.current = socket;
          transportRef.current = "local";
          setStatus("ready");
          setStatusDetail(roleRef.current === "host" ? "Локальная комната открыта" : "Локальный signaling готов");
          socket.send(
            JSON.stringify({
              type: "join",
              roomCode: nextRoomCode,
              peer: selfPeer()
            })
          );
          resolve(true);
        };

        socket.onmessage = (event) => {
          try {
            void handleLocalSignalMessage(JSON.parse(event.data) as LocalSignalMessage);
          } catch {
            addSystemMessage("Локальный signaling прислал некорректное сообщение.");
          }
        };

        socket.onclose = () => {
          if (localSocketRef.current === socket) {
            localSocketRef.current = null;
          }

          if (transportRef.current === "local") {
            setStatus("reconnecting");
            setStatusDetail("Локальный signaling отключился. Нажмите Повтор или перезапустите сервер.");
          }
        };

        socket.onerror = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          socket.close();
          resolve(false);
        };
      });
    },
    [addSystemMessage, handleLocalSignalMessage, localSignalUrl, selfPeer]
  );

  const callPeer = useCallback(
    (peerId: string) => {
      if (transportRef.current === "local") return;

      const peer = peerRef.current;
      const stream = activeSendStream();
      if (!peer || !stream || !stream.getTracks().length || peerId === selfPeerIdRef.current) {
        return;
      }

      closeMediaCall(peerId);
      const call = peer.call(peerId, stream, {
        metadata: {
          roomCode: roomCodeRef.current,
          peer: selfPeer()
        }
      });
      wireMediaCall(call);
    },
    [activeSendStream, closeMediaCall, selfPeer, wireMediaCall]
  );

  const callAllPeers = useCallback(() => {
    if (transportRef.current === "local") {
      updateLocalMediaTracks();
      return;
    }

    connectionsRef.current.forEach((connection, peerId) => {
      if (connection.open) callPeer(peerId);
    });
  }, [callPeer, updateLocalMediaTracks]);

  const handleWireMessage = useCallback(
    (fromPeerId: string, message: WireMessage) => {
      if (message.roomCode !== roomCodeRef.current) return;

      if (message.type === "hello") {
        setParticipant(message.peer, { connected: true });

        if (roleRef.current === "host") {
          const roster = [
            selfPeer(),
            ...participantsRef.current.map((participant) => ({
              peerId: participant.peerId,
              participantId: participant.participantId,
              name: participant.name,
              role: participant.role
            }))
          ];
          const connection = connectionsRef.current.get(fromPeerId);
          if (connection) {
            sendToConnection(connection, {
              type: "roster",
              peers: roster,
              roomCode: roomCodeRef.current
            });
          }
          broadcast(
            {
              type: "peer-joined",
              peer: message.peer,
              roomCode: roomCodeRef.current
            },
            fromPeerId
          );
        }
        return;
      }

      if (message.type === "roster") {
        for (const peer of message.peers) {
          if (peer.peerId !== selfPeerIdRef.current) {
            setParticipant(peer, { connected: true });
            connectToPeer(peer.peerId);
          }
        }
        return;
      }

      if (message.type === "peer-joined") {
        setParticipant(message.peer, { connected: true });
        connectToPeer(message.peer.peerId);
        return;
      }

      if (message.type === "peer-left") {
        closeDataConnection(message.peerId);
        return;
      }

      if (message.type === "chat") {
        setMessages((current) => {
          if (current.some((item) => item.id === message.id)) return current;
          return [
            ...current,
            {
              id: message.id,
              author: message.author,
              text: message.text,
              time: message.time
            }
          ];
        });
      }
    },
    [broadcast, closeDataConnection, selfPeer, sendToConnection, setParticipant]
  );

  const wireDataConnection = useCallback(
    (connection: DataConnection) => {
      if (connection.peer === selfPeerIdRef.current) return;

      const existing = connectionsRef.current.get(connection.peer);
      if (existing && existing.open) {
        connection.close();
        return;
      }

      connectionsRef.current.set(connection.peer, connection);

      connection.on("open", () => {
        setStatus("ready");
        setStatusDetail(roleRef.current === "host" ? "Комната открыта" : "Вы в комнате");

        const remotePeer = connection.metadata?.peer as RoomPeer | undefined;
        if (remotePeer) {
          setParticipant(remotePeer, { connected: true });
        }

        sendToConnection(connection, {
          type: "hello",
          peer: selfPeer(),
          roomCode: roomCodeRef.current
        });

        if (activeSendStream()?.getTracks().length) {
          callPeer(connection.peer);
        }
      });

      connection.on("data", (data) => {
        handleWireMessage(connection.peer, data as WireMessage);
      });

      connection.on("close", () => {
        connectionsRef.current.delete(connection.peer);
        closeMediaCall(connection.peer);
        setParticipants((current) =>
          current.map((participant) =>
            participant.peerId === connection.peer
              ? { ...participant, connected: false, remoteStream: null }
              : participant
          )
        );
      });

      connection.on("error", () => {
        connectionsRef.current.delete(connection.peer);
        closeMediaCall(connection.peer);
      });
    },
    [
      activeSendStream,
      callPeer,
      closeMediaCall,
      handleWireMessage,
      selfPeer,
      sendToConnection,
      setParticipant
    ]
  );

  const connectToPeer = useCallback(
    (targetPeerId: string) => {
      const peer = peerRef.current;
      if (!peer || !peer.open || targetPeerId === selfPeerIdRef.current) return;

      const existing = connectionsRef.current.get(targetPeerId);
      if (existing?.open) return;

      const connection = peer.connect(targetPeerId, {
        reliable: true,
        serialization: "json",
        metadata: {
          roomCode: roomCodeRef.current,
          peer: selfPeer()
        }
      });
      wireDataConnection(connection);
    },
    [selfPeer, wireDataConnection]
  );

  const connectToHost = useCallback(() => {
    if (roleRef.current !== "guest" || !roomCodeRef.current) return;

    const targetHostId = hostPeerId(roomCodeRef.current);
    if (connectionsRef.current.get(targetHostId)?.open) return;

    setStatus("connecting");
    setStatusDetail("Ищем ведущего комнаты");
    connectToPeer(targetHostId);
  }, [connectToPeer]);

  const createPeerInstance = useCallback(
    async (nextRoomCode: string, nextRole: Role, attempt = 0) => {
      cleanupPeer();

      const nextPeerId =
        nextRole === "host"
          ? hostPeerId(nextRoomCode)
          : guestPeerId(nextRoomCode, participantId, createId(4));

      setRoomCode(nextRoomCode);
      setRole(nextRole);
      setSelfPeerId(nextPeerId);
      setStatus("connecting");
      setStatusDetail(nextRole === "host" ? "Открываем комнату" : "Подключаемся к комнате");
      roomCodeRef.current = nextRoomCode;
      roleRef.current = nextRole;
      selfPeerIdRef.current = nextPeerId;

      if (await startLocalSignaling(nextRoomCode)) {
        return;
      }

      transportRef.current = "peerjs";
      const { Peer } = await import("peerjs");
      const peer = new Peer(nextPeerId, peerOptions);
      peerRef.current = peer;

      const scheduleRetry = (detail: string, delayMs = Math.min(1800 + attempt * 900, 8000)) => {
        const cleanDetail = detail.replace(/[.\s]+$/g, "");
        if (peerRef.current === peer) {
          peer.removeAllListeners();
          peer.destroy();
          peerRef.current = null;
        }

        if (openWatchdogTimerRef.current) {
          window.clearTimeout(openWatchdogTimerRef.current);
          openWatchdogTimerRef.current = null;
        }
        if (retryTimerRef.current) {
          window.clearTimeout(retryTimerRef.current);
        }

        const nextAttempt = attempt + 1;
        setStatus("reconnecting");
        setStatusDetail(`${cleanDetail}. Повтор ${nextAttempt + 1}`);
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          if (roomCodeRef.current !== nextRoomCode || roleRef.current !== nextRole) return;
          void createPeerInstance(nextRoomCode, nextRole, nextAttempt);
        }, delayMs);
      };

      openWatchdogTimerRef.current = window.setTimeout(() => {
        if (peerRef.current !== peer || peer.open || peer.destroyed) return;

        scheduleRetry(`Signaling не ответил за ${Math.round(SIGNALING_WATCHDOG_MS / 1000)} секунд`);
      }, SIGNALING_WATCHDOG_MS);

      peer.on("open", () => {
        if (openWatchdogTimerRef.current) {
          window.clearTimeout(openWatchdogTimerRef.current);
          openWatchdogTimerRef.current = null;
        }

        setStatus("ready");
        setStatusDetail(nextRole === "host" ? "Комната открыта" : "Готово, ищем ведущего");

        if (nextRole === "guest") {
          connectToHost();
          reconnectTimerRef.current = window.setInterval(connectToHost, 2500);
        }
      });

      peer.on("connection", (connection) => {
        const metadataRoom = connection.metadata?.roomCode as string | undefined;
        if (metadataRoom && metadataRoom !== roomCodeRef.current) {
          connection.close();
          return;
        }
        wireDataConnection(connection);
      });

      peer.on("call", (call) => {
        const metadataRoom = call.metadata?.roomCode as string | undefined;
        if (metadataRoom && metadataRoom !== roomCodeRef.current) {
          call.close();
          return;
        }

        const remotePeer = call.metadata?.peer as RoomPeer | undefined;
        if (remotePeer) {
          setParticipant(remotePeer, { connected: true });
        }
        call.answer(activeSendStream() ?? new MediaStream());
        wireMediaCall(call);
      });

      peer.on("disconnected", () => {
        setStatus("reconnecting");
        setStatusDetail("Потеряна связь с signaling, переподключаемся");
        if (!peer.destroyed) {
          try {
            peer.reconnect();
          } catch {
            scheduleRetry("Не удалось переподключиться к signaling");
          }
        }
      });

      peer.on("error", (error) => {
        if (openWatchdogTimerRef.current) {
          window.clearTimeout(openWatchdogTimerRef.current);
          openWatchdogTimerRef.current = null;
        }

        if (error.type === "peer-unavailable" && roleRef.current === "guest") {
          setStatus("reconnecting");
          setStatusDetail("Ведущий еще не в комнате, повторяем подключение");
          return;
        }

        if (error.type === "unavailable-id" && nextRole === "host") {
          const replacementRoomCode = createRoomCode();
          window.sessionStorage.setItem(HOST_STORAGE_KEY, replacementRoomCode);
          updateRoomUrl(replacementRoomCode);
          addSystemMessage(
            `Комната ${nextRoomCode} еще занята на signaling. Создана новая комната ${replacementRoomCode}.`
          );
          void createPeerInstance(replacementRoomCode, "host", 0);
          return;
        }

        if (error.type === "unavailable-id" && nextRole === "guest") {
          scheduleRetry("ID участника занят, переподключаемся", 600);
          return;
        }

        if (
          error.type === "network" ||
          error.type === "server-error" ||
          error.type === "socket-error" ||
          error.type === "socket-closed"
        ) {
          scheduleRetry("Публичный signaling недоступен");
          return;
        }

        setStatus("error");
        setStatusDetail(error.message || "Ошибка signaling");
      });
    },
    [
      addSystemMessage,
      activeSendStream,
      cleanupPeer,
      connectToHost,
      participantId,
      setParticipant,
      startLocalSignaling,
      updateRoomUrl,
      wireDataConnection,
      wireMediaCall
    ]
  );

  const startRoom = useCallback(
    (nextRoomCode: string, nextRole: Role) => {
      const cleanRoom = sanitizeRoomCode(nextRoomCode) || createRoomCode();
      if (nextRole === "host") {
        window.sessionStorage.setItem(HOST_STORAGE_KEY, cleanRoom);
      } else if (window.sessionStorage.getItem(HOST_STORAGE_KEY) !== cleanRoom) {
        window.sessionStorage.removeItem(HOST_STORAGE_KEY);
      }
      setJoinCode("");
      updateRoomUrl(cleanRoom);
      void createPeerInstance(cleanRoom, nextRole);
    },
    [createPeerInstance, updateRoomUrl]
  );

  const createNewRoom = useCallback(() => {
    const nextRoomCode = createRoomCode();
    addSystemMessage(`Создана новая комната ${nextRoomCode}.`);
    startRoom(nextRoomCode, "host");
  }, [addSystemMessage, startRoom]);

  const retryCurrentRoom = useCallback(() => {
    const currentRoomCode = roomCodeRef.current || sanitizeRoomCode(roomCode);
    if (!currentRoomCode) {
      createNewRoom();
      return;
    }

    addSystemMessage(`Повторяем подключение к комнате ${currentRoomCode}.`);
    void createPeerInstance(currentRoomCode, roleRef.current, 0);
  }, [addSystemMessage, createNewRoom, createPeerInstance, roomCode]);

  const joinCurrentRoom = useCallback(() => {
    const cleanJoinCode = sanitizeRoomCode(joinCode);
    if (!cleanJoinCode) {
      showToast("Введите код комнаты");
      return;
    }

    if (roleRef.current === "host" && cleanJoinCode === roomCodeRef.current) {
      showToast("Вы уже ведущий этой комнаты");
      return;
    }

    startRoom(cleanJoinCode, "guest");
  }, [joinCode, showToast, startRoom]);

  const copyText = useCallback(
    async (text: string, message = "Скопировано") => {
      await navigator.clipboard.writeText(text);
      showToast(message);
    },
    [showToast]
  );

  const publishProfile = useCallback(() => {
    if (!selfPeerIdRef.current || !roomCodeRef.current) return;

    if (transportRef.current === "local") {
      sendLocalSignal({
        type: "profile",
        roomCode: roomCodeRef.current,
        peer: selfPeer()
      });
      return;
    }

    if (transportRef.current === "peerjs") {
      broadcast({
        type: "peer-joined",
        peer: selfPeer(),
        roomCode: roomCodeRef.current
      });
    }
  }, [broadcast, selfPeer, sendLocalSignal]);

  const publishProfileBurst = useCallback(() => {
    publishProfile();
    window.setTimeout(publishProfile, 250);
    window.setTimeout(publishProfile, 1000);
    window.setTimeout(publishProfile, 2500);
  }, [publishProfile]);

  const updateDisplayName = useCallback(
    (nextName: string) => {
      displayNameRef.current = nextName;
      setDisplayName(nextName);
      window.localStorage.setItem(NAME_STORAGE_KEY, nextName);
      publishProfileBurst();
    },
    [publishProfileBurst]
  );

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const allDevices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = allDevices.filter((device) => device.kind === "audioinput");
    const videoInputs = allDevices.filter((device) => device.kind === "videoinput");
    setDevices({ audioInputs, videoInputs });
    setAudioDeviceId((current) => current || audioInputs[0]?.deviceId || "");
    setVideoDeviceId((current) => current || videoInputs[0]?.deviceId || "");
  }, []);

  const startLocalMedia = useCallback(async () => {
    try {
      const constraints: MediaStreamConstraints = {
        audio: audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true,
        video: videoDeviceId
          ? {
              deviceId: { exact: videoDeviceId },
              width: { ideal: 1280 },
              height: { ideal: 720 }
            }
          : {
              width: { ideal: 1280 },
              height: { ideal: 720 }
            }
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.getAudioTracks().forEach((track) => {
        track.enabled = micEnabled;
      });
      stream.getVideoTracks().forEach((track) => {
        track.enabled = cameraEnabled;
      });

      const previous = localStreamRef.current;
      setLocalStream(stream);
      setPreviewStream(screenStreamRef.current ?? stream);
      localStreamRef.current = stream;
      await refreshDevices();

      if (previous && previous !== stream) stopStream(previous);
      callAllPeers();
      showToast("Камера и микрофон готовы.");
    } catch (error) {
      addSystemMessage(
        error instanceof Error
          ? `Не удалось включить камеру или микрофон: ${error.message}`
          : "Не удалось включить камеру или микрофон."
      );
    }
  }, [
    addSystemMessage,
    audioDeviceId,
    callAllPeers,
    cameraEnabled,
    micEnabled,
    refreshDevices,
    showToast,
    videoDeviceId
  ]);

  const toggleMic = useCallback(() => {
    setMicEnabled((current) => {
      const next = !current;
      localStreamRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = next;
      });
      return next;
    });
  }, []);

  const toggleCamera = useCallback(() => {
    setCameraEnabled((current) => {
      const next = !current;
      localStreamRef.current?.getVideoTracks().forEach((track) => {
        track.enabled = next;
      });
      return next;
    });
  }, []);

  const stopScreenShare = useCallback(() => {
    stopStream(screenStreamRef.current);
    setScreenStream(null);
    screenStreamRef.current = null;
    setPreviewStream(localStreamRef.current);
    setIsSharingScreen(false);

    mediaCallsRef.current.forEach((call) => call.close());
    mediaCallsRef.current.clear();
    if (localStreamRef.current) callAllPeers();
    showToast("Демонстрация экрана остановлена.");
  }, [callAllPeers, showToast]);

  const startScreenShare = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: false
      });
      const screenTrack = stream.getVideoTracks()[0];
      if (!screenTrack) throw new Error("Браузер не вернул видеодорожку экрана.");

      screenTrack.onended = stopScreenShare;
      setScreenStream(stream);
      screenStreamRef.current = stream;
      setPreviewStream(stream);
      setIsSharingScreen(true);

      mediaCallsRef.current.forEach((call) => call.close());
      mediaCallsRef.current.clear();
      callAllPeers();
      showToast("Демонстрация экрана включена.");
    } catch (error) {
      addSystemMessage(
        error instanceof Error
          ? `Не удалось включить экран: ${error.message}`
          : "Не удалось включить демонстрацию экрана."
      );
    }
  }, [addSystemMessage, callAllPeers, showToast, stopScreenShare]);

  const sendChat = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const text = chatText.trim();
      if (!text) return;

      const message: WireMessage = {
        type: "chat",
        id: createId(),
        author: displayNameRef.current.trim() || "Гость",
        text,
        time: Date.now(),
        roomCode: roomCodeRef.current
      };

      if (transportRef.current === "local") {
        sendLocalSignal(message);
      } else {
        broadcast(message);
      }
      setMessages((current) => [...current, { ...message, local: true }]);
      setChatText("");
    },
    [broadcast, chatText, sendLocalSignal]
  );

  const leaveRoom = useCallback(() => {
    broadcast({
      type: "peer-left",
      peerId: selfPeerIdRef.current,
      roomCode: roomCodeRef.current
    });
    cleanupPeer();
    setStatus("booting");
    setStatusDetail("Комната закрыта локально");
  }, [broadcast, cleanupPeer]);

  useEffect(() => {
    addSystemMessage(
      "Комната подключается автоматически. Камера и микрофон не обязательны: можно войти только для чата."
    );

    const savedName = window.localStorage.getItem(NAME_STORAGE_KEY);
    if (savedName) {
      setDisplayName(savedName);
      displayNameRef.current = savedName;
    }

    const params = new URLSearchParams(window.location.search);
    const codeFromUrl = sanitizeRoomCode(params.get(ROOM_PARAM) ?? "");
    const ownedRoom = window.sessionStorage.getItem(HOST_STORAGE_KEY);

    if (codeFromUrl) {
      setRoomCode(codeFromUrl);
      const nextRole: Role = ownedRoom === codeFromUrl ? "host" : "guest";
      void createPeerInstance(codeFromUrl, nextRole);
    } else {
      const nextRoomCode = createRoomCode();
      window.sessionStorage.setItem(HOST_STORAGE_KEY, nextRoomCode);
      updateRoomUrl(nextRoomCode);
      setRoomCode(nextRoomCode);
      void createPeerInstance(nextRoomCode, "host");
    }

    void refreshDevices();

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register(`${basePath}/sw.js`).catch(() => undefined);
      });
    }

    const onBeforeUnload = () => {
      broadcast({
        type: "peer-left",
        peerId: selfPeerIdRef.current,
        roomCode: roomCodeRef.current
      });
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      cleanupPeer();
      stopStream(screenStreamRef.current);
      stopStream(localStreamRef.current);
    };
  }, [addSystemMessage, broadcast, cleanupPeer, createPeerInstance, refreshDevices, updateRoomUrl]);

  useEffect(() => {
    window.localStorage.setItem(NAME_STORAGE_KEY, displayName);
  }, [displayName]);

  return (
    <main className="app-shell">
      <div className="workspace">
        <aside className="sidebar">
          <div className="panel">
            <section className="section">
              <div className="brand">
                <div className="brand-mark" aria-hidden="true">
                  <Video size={24} />
                </div>
                <div>
                  <h1 className="brand-title">OnlineCall</h1>
                  <p className="brand-subtitle">Комната по короткому коду</p>
                </div>
              </div>
            </section>

            <section className="section">
              <div className="section-title">
                <h2>Комната</h2>
                {status === "ready" ? <Wifi size={18} /> : <WifiOff size={18} />}
              </div>
              <div className="room-code">{roomCode || "------"}</div>
              <div className="button-row">
                <button className="btn btn-secondary" type="button" onClick={createNewRoom}>
                  <Plus size={17} />
                  Новая
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  disabled={!roomLink}
                  onClick={() => copyText(roomLink, "Ссылка комнаты скопирована")}
                >
                  <Link size={17} />
                  Ссылка
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  disabled={!roomCode}
                  onClick={() => copyText(roomCode, "Код комнаты скопирован")}
                >
                  <Copy size={17} />
                  Код
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  disabled={!roomCode}
                  onClick={retryCurrentRoom}
                >
                  <RefreshCw size={17} />
                  Повтор
                </button>
              </div>
              <div className={`connection-banner ${status}`}>
                {status === "connecting" || status === "reconnecting" || status === "booting" ? (
                  <Loader2 size={16} className="spin" />
                ) : status === "ready" ? (
                  <Check size={16} />
                ) : (
                  <WifiOff size={16} />
                )}
                <span>
                  {statusText(status, role)}: {statusDetail}
                </span>
              </div>
              <p className="helper">
                Подключение автоматическое. Дайте человеку ссылку или код комнаты, ручной обмен
                техническими кодами больше не нужен.
              </p>
            </section>

            <section className="section">
              <div className="section-title">
                <h2>Профиль</h2>
                <ShieldCheck size={18} aria-hidden="true" />
              </div>
              <div className="field">
                <label htmlFor="displayName">Ваше имя</label>
                <input
                  id="displayName"
                  className="input"
                  value={displayName}
                  maxLength={34}
                  onChange={(event) => updateDisplayName(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="roomInput">Войти по коду</label>
                <div className="copy-row">
                  <input
                    id="roomInput"
                    className="input"
                    value={joinCode}
                    placeholder="например abc123"
                    onChange={(event) => setJoinCode(sanitizeRoomCode(event.target.value))}
                  />
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={!sanitizeRoomCode(joinCode)}
                    onClick={joinCurrentRoom}
                  >
                    Войти
                  </button>
                </div>
              </div>
            </section>

            <section className="section">
              <div className="section-title">
                <h2>Устройства</h2>
                <Settings2 size={18} aria-hidden="true" />
              </div>
              <div className="field">
                <label htmlFor="audioDevice">Микрофон</label>
                <select
                  id="audioDevice"
                  className="select"
                  value={audioDeviceId}
                  onChange={(event) => setAudioDeviceId(event.target.value)}
                >
                  {devices.audioInputs.length === 0 ? (
                    <option value="">По умолчанию</option>
                  ) : (
                    devices.audioInputs.map((device, index) => (
                      <option key={device.deviceId || index} value={device.deviceId}>
                        {device.label || `Микрофон ${index + 1}`}
                      </option>
                    ))
                  )}
                </select>
              </div>
              <div className="field">
                <label htmlFor="videoDevice">Камера</label>
                <select
                  id="videoDevice"
                  className="select"
                  value={videoDeviceId}
                  onChange={(event) => setVideoDeviceId(event.target.value)}
                >
                  {devices.videoInputs.length === 0 ? (
                    <option value="">По умолчанию</option>
                  ) : (
                    devices.videoInputs.map((device, index) => (
                      <option key={device.deviceId || index} value={device.deviceId}>
                        {device.label || `Камера ${index + 1}`}
                      </option>
                    ))
                  )}
                </select>
              </div>
              <div className="button-row">
                <button className="btn btn-primary" type="button" onClick={startLocalMedia}>
                  <Camera size={17} />
                  {hasLocalMedia ? "Перезапустить медиа" : "Включить медиа"}
                </button>
                <button className="btn btn-secondary" type="button" onClick={refreshDevices}>
                  <RefreshCw size={17} />
                  Обновить
                </button>
              </div>
              <p className="helper">Без камеры и микрофона комната тоже работает: чат и просмотр доступны.</p>
            </section>
          </div>
        </aside>

        <section className="stage panel">
          <header className="topbar">
            <div className="room-title">
              <h1>Комната {roomCode}</h1>
              <p>
                {connectedCount} подключено, роль: {role === "host" ? "ведущий" : "участник"}
              </p>
            </div>
            <div className="status-pill">
              <span className={`dot ${status === "ready" ? "ready" : ""}`} />
              {statusText(status, role)}
            </div>
          </header>

          <div className="video-grid">
            <div className="video-tile">
              {previewStream ? (
                <VideoElement stream={previewStream} muted />
              ) : (
                <div className="video-placeholder">
                  <div>
                    <CameraOff size={34} />
                    <div>Вы без локального видео</div>
                  </div>
                </div>
              )}
              <div className="tile-badge">
                <UserRound size={15} />
                <span>{displayName || "Вы"}</span>
              </div>
            </div>

            {participants
              .filter((participant) => participant.remoteStream)
              .map((participant) => (
                <div className="video-tile" key={participant.peerId}>
                  <VideoElement stream={participant.remoteStream} />
                  <div className="tile-badge">
                    <UsersRound size={15} />
                    <span>{participant.name}</span>
                  </div>
                </div>
              ))}

            {!participants.some((participant) => participant.remoteStream) && (
              <div className="video-tile">
                <div className="video-placeholder">
                  <div>
                    <UsersRound size={34} />
                    <div>Видео участников появится, когда они включат камеру или экран</div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <footer className="stage-controls">
            <div className="control-group">
              <button
                className={`control-btn ${micEnabled ? "active" : "danger"}`}
                type="button"
                title={micEnabled ? "Выключить микрофон" : "Включить микрофон"}
                onClick={toggleMic}
                disabled={!hasLocalMedia}
              >
                {micEnabled ? <Mic size={21} /> : <MicOff size={21} />}
              </button>
              <button
                className={`control-btn ${cameraEnabled ? "active" : "danger"}`}
                type="button"
                title={cameraEnabled ? "Выключить камеру" : "Включить камеру"}
                onClick={toggleCamera}
                disabled={!hasLocalMedia}
              >
                {cameraEnabled ? <Camera size={21} /> : <CameraOff size={21} />}
              </button>
              <button
                className={`control-btn ${isSharingScreen ? "active" : ""}`}
                type="button"
                title={isSharingScreen ? "Остановить демонстрацию" : "Показать экран"}
                onClick={isSharingScreen ? stopScreenShare : startScreenShare}
              >
                {isSharingScreen ? <ScreenShareOff size={21} /> : <MonitorUp size={21} />}
              </button>
              <button className="control-btn danger" type="button" title="Выйти" onClick={leaveRoom}>
                <PhoneOff size={21} />
              </button>
            </div>
            <div className="status-line">
              Видео: {getTrackLabel(localStream?.getVideoTracks()[0])}
              <br />
              Аудио: {getTrackLabel(localStream?.getAudioTracks()[0])}
            </div>
          </footer>
        </section>

        <aside className="side-panel">
          <div className="panel">
            <section className="section">
              <div className="section-title">
                <h2>Участники</h2>
                <UsersRound size={18} aria-hidden="true" />
              </div>
              <div className="peer-list">
                <ParticipantRow
                  name={`${displayName || "Вы"} (вы)`}
                  role={role}
                  connected={status === "ready"}
                />
                {participants.length ? (
                  participants.map((participant) => (
                    <ParticipantRow
                      key={participant.peerId}
                      name={participant.name}
                      role={participant.role}
                      connected={participant.connected}
                    />
                  ))
                ) : (
                  <div className="empty-state">
                    <div>
                      <UsersRound size={30} />
                      <div>Пока никого нет</div>
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>

          <div className="panel">
            <section className="section">
              <div className="section-title">
                <h2>Чат</h2>
                <MessageSquareText size={18} aria-hidden="true" />
              </div>
              <div className="chat-log" aria-live="polite">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`message ${message.local ? "local" : ""} ${
                      message.system ? "system" : ""
                    }`}
                  >
                    <div className="message-meta">
                      <span>{message.author}</span>
                      <span className="message-time">{formatTime(message.time)}</span>
                    </div>
                    <div className="message-text">{message.text}</div>
                  </div>
                ))}
              </div>
              <form className="chat-form" onSubmit={sendChat}>
                <input
                  className="input"
                  value={chatText}
                  onChange={(event) => setChatText(event.target.value)}
                  placeholder="Сообщение в чат"
                />
                <button className="btn btn-primary" type="submit" disabled={!chatText.trim()}>
                  <Send size={17} />
                  Отправить
                </button>
              </form>
            </section>
          </div>
        </aside>
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
    </main>
  );
}

function ParticipantRow({
  name,
  role,
  connected
}: {
  name: string;
  role: Role;
  connected: boolean;
}) {
  return (
    <div className="participant-row">
      <div className="peer-name">
        <strong>{name}</strong>
        <span className="status-text">{role === "host" ? "ведущий" : "участник"}</span>
      </div>
      <span className={`badge ${connected ? "connected" : "waiting"}`}>
        {connected ? "онлайн" : "ожидание"}
      </span>
    </div>
  );
}
