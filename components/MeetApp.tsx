"use client";

import {
  Camera,
  CameraOff,
  Check,
  Clipboard,
  Copy,
  Link,
  Loader2,
  MessageSquareText,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  RefreshCw,
  ScreenShareOff,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  UserRound,
  UsersRound,
  Video,
  Wifi,
  WifiOff
} from "lucide-react";
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

type RoomPeer = {
  peerId: string;
  participantId: string;
  name: string;
  role: Role;
};

type Participant = RoomPeer & {
  connected: boolean;
  remoteStream: MediaStream | null;
  connectionState: RTCPeerConnectionState | "new";
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

type SignalPayload =
  | { kind: "description"; description: RTCSessionDescriptionInit }
  | { kind: "candidate"; candidate: RTCIceCandidateInit };

type ServerMessage =
  | { type: "joined"; roomCode: string; peers: RoomPeer[] }
  | { type: "peer-joined"; roomCode: string; peer: RoomPeer }
  | { type: "peer-updated"; roomCode: string; peer: RoomPeer }
  | { type: "peer-left"; roomCode: string; peerId: string }
  | { type: "signal"; roomCode: string; fromPeerId: string; peer: RoomPeer; signal: SignalPayload }
  | { type: "chat"; id: string; author: string; text: string; time: number; roomCode: string }
  | { type: "pong"; time: number }
  | { type: "error"; message: string };

type PeerRuntime = {
  connection: RTCPeerConnection;
  wiring: PeerWiring;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
};

const ROOM_PARAM = "room";
const NAME_STORAGE_KEY = "online-call-name";
const RECONNECT_DELAY_MS = 1400;

function createId(length = 10) {
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

function formatTime(value: number) {
  return new Intl.DateTimeFormat("ru", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(value);
}

function statusText(status: Status) {
  if (status === "ready") return "локальная комната открыта";
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
  const [peerId] = useState(() => `oc-${createId(14)}`);
  const [displayName, setDisplayName] = useState("Гость");
  const [roomCode, setRoomCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [role, setRole] = useState<Role>("host");
  const [status, setStatus] = useState<Status>("booting");
  const [statusDetail, setStatusDetail] = useState("Готовим локальный сервер");
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

  const socketRef = useRef<WebSocket | null>(null);
  const peersRef = useRef(new Map<string, PeerRuntime>());
  const localStreamRef = useRef(localStream);
  const screenStreamRef = useRef(screenStream);
  const roomCodeRef = useRef(roomCode);
  const roleRef = useRef(role);
  const displayNameRef = useRef(displayName);
  const reconnectTimerRef = useRef<number | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);

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
    displayNameRef.current = displayName;
  }, [displayName]);

  const connectedParticipants = participants.filter((participant) => participant.connected);
  const activeSendStream = screenStream ?? localStream;
  const hasLocalMedia = Boolean(localStream);

  const roomLink = useMemo(() => {
    if (typeof window === "undefined" || !roomCode) return "";
    const url = new URL(window.location.href);
    url.searchParams.set(ROOM_PARAM, roomCode);
    return url.toString();
  }, [roomCode]);

  const selfPeer = useCallback(
    (): RoomPeer => ({
      peerId,
      participantId,
      name: displayNameRef.current.trim() || "Гость",
      role: roleRef.current
    }),
    [participantId, peerId]
  );

  const showToast = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(""), 2200);
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

  const socketUrl = useCallback(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws`;
  }, []);

  const sendSocket = useCallback((message: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return true;
    }
    return false;
  }, []);

  const updateRoomUrl = useCallback((nextRoomCode: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set(ROOM_PARAM, nextRoomCode);
    window.history.replaceState(null, "", url.toString());
  }, []);

  const upsertParticipant = useCallback((peer: RoomPeer, patch?: Partial<Participant>) => {
    if (!peer.peerId || peer.peerId === peerId) return;

    setParticipants((current) => {
      const existing = current.find((participant) => participant.peerId === peer.peerId);
      if (existing) {
        return current.map((participant) =>
          participant.peerId === peer.peerId
            ? {
                ...participant,
                participantId: peer.participantId || participant.participantId,
                name: peer.name || participant.name,
                role: peer.role || participant.role,
                connected: patch?.connected ?? participant.connected,
                remoteStream:
                  patch && "remoteStream" in patch ? patch.remoteStream ?? null : participant.remoteStream,
                connectionState: patch?.connectionState ?? participant.connectionState
              }
            : participant
        );
      }

      return [
        ...current,
        {
          peerId: peer.peerId,
          participantId: peer.participantId,
          name: peer.name || "Гость",
          role: peer.role,
          connected: patch?.connected ?? true,
          remoteStream: patch?.remoteStream ?? null,
          connectionState: patch?.connectionState ?? "new"
        }
      ];
    });
  }, [peerId]);

  const markParticipant = useCallback((remotePeerId: string, patch: Partial<Participant>) => {
    setParticipants((current) =>
      current.map((participant) =>
        participant.peerId === remotePeerId ? { ...participant, ...patch } : participant
      )
    );
  }, []);

  const removeParticipant = useCallback((remotePeerId: string) => {
    peersRef.current.get(remotePeerId)?.connection.close();
    peersRef.current.delete(remotePeerId);
    setParticipants((current) => current.filter((participant) => participant.peerId !== remotePeerId));
  }, []);

  const closeAllPeers = useCallback(() => {
    peersRef.current.forEach((runtime) => runtime.connection.close());
    peersRef.current.clear();
    setParticipants([]);
  }, []);

  const publishProfile = useCallback(() => {
    sendSocket({
      type: "profile",
      roomCode: roomCodeRef.current,
      peer: selfPeer()
    });
  }, [selfPeer, sendSocket]);

  const publishProfileBurst = useCallback(() => {
    publishProfile();
    window.setTimeout(publishProfile, 250);
    window.setTimeout(publishProfile, 1000);
  }, [publishProfile]);

  const sendSignal = useCallback(
    (toPeerId: string, signal: SignalPayload) => {
      sendSocket({
        type: "signal",
        roomCode: roomCodeRef.current,
        toPeerId,
        signal
      });
    },
    [sendSocket]
  );

  const negotiate = useCallback(
    async (remotePeerId: string, runtime: PeerRuntime) => {
      if (runtime.connection.signalingState !== "stable") return;

      try {
        runtime.makingOffer = true;
        const offer = await runtime.connection.createOffer();
        await runtime.connection.setLocalDescription(offer);
        if (runtime.connection.localDescription) {
          sendSignal(remotePeerId, {
            kind: "description",
            description: runtime.connection.localDescription.toJSON()
          });
        }
      } catch {
        // Another peer can start negotiation at the same time. Perfect negotiation will recover
        // through the incoming offer/answer path, so this local attempt can be skipped.
      } finally {
        runtime.makingOffer = false;
      }
    },
    [sendSignal]
  );

  const createPeerConnection = useCallback(
    (remotePeer: RoomPeer) => {
      const existing = peersRef.current.get(remotePeer.peerId);
      if (existing) {
        upsertParticipant(remotePeer, { connected: true });
        return existing;
      }

      const connection = new RTCPeerConnection(createRtcConfig("public-stun"));
      const wiring = attachLocalMedia(connection, activeSendStream);
      const runtime: PeerRuntime = {
        connection,
        wiring,
        polite: peerId > remotePeer.peerId,
        makingOffer: false,
        ignoreOffer: false
      };

      peersRef.current.set(remotePeer.peerId, runtime);
      upsertParticipant(remotePeer, { connected: true, connectionState: connection.connectionState });

      connection.onicecandidate = (event) => {
        if (!event.candidate) return;
        sendSignal(remotePeer.peerId, {
          kind: "candidate",
          candidate: event.candidate.toJSON()
        });
      };

      connection.ontrack = (event) => {
        const [stream] = event.streams;
        markParticipant(remotePeer.peerId, {
          connected: true,
          remoteStream: stream ?? new MediaStream([event.track])
        });
      };

      connection.onconnectionstatechange = () => {
        const state = connection.connectionState;
        markParticipant(remotePeer.peerId, {
          connected: state === "connected" || state === "connecting" || state === "new",
          connectionState: state,
          ...(state === "closed" || state === "failed" ? { remoteStream: null } : {})
        });
      };

      connection.onnegotiationneeded = () => {
        void negotiate(remotePeer.peerId, runtime);
      };

      return runtime;
    },
    [activeSendStream, markParticipant, negotiate, peerId, sendSignal, upsertParticipant]
  );

  const handleSignal = useCallback(
    async (fromPeerId: string, remotePeer: RoomPeer, signal: SignalPayload) => {
      const runtime = createPeerConnection(remotePeer);

      try {
        if (signal.kind === "description") {
          const offerCollision =
            signal.description.type === "offer" &&
            (runtime.makingOffer || runtime.connection.signalingState !== "stable");

          runtime.ignoreOffer = !runtime.polite && offerCollision;
          if (runtime.ignoreOffer) return;

          await runtime.connection.setRemoteDescription(signal.description);
          if (signal.description.type === "offer") {
            const answer = await runtime.connection.createAnswer();
            await runtime.connection.setLocalDescription(answer);
            if (runtime.connection.localDescription) {
              sendSignal(fromPeerId, {
                kind: "description",
                description: runtime.connection.localDescription.toJSON()
              });
            }
          }
          return;
        }

        if (!runtime.ignoreOffer) {
          await runtime.connection.addIceCandidate(signal.candidate);
        }
      } catch (error) {
        addSystemMessage(
          error instanceof Error
            ? `Ошибка WebRTC с ${remotePeer.name}: ${error.message}`
            : `Ошибка WebRTC с ${remotePeer.name}.`
        );
      }
    },
    [addSystemMessage, createPeerConnection, sendSignal]
  );

  const updateOutgoingTracks = useCallback(() => {
    const stream = screenStreamRef.current ?? localStreamRef.current;
    const audioTrack = stream?.getAudioTracks()[0] ?? null;
    const videoTrack = stream?.getVideoTracks()[0] ?? null;

    peersRef.current.forEach((runtime, remotePeerId) => {
      void replaceSenderTrack(runtime.wiring.audioSender, audioTrack);
      void replaceSenderTrack(runtime.wiring.videoSender, videoTrack);
      void negotiate(remotePeerId, runtime);
    });
  }, [negotiate]);

  const handleServerMessage = useCallback(
    (message: ServerMessage) => {
      if (message.type === "error") {
        setStatus("error");
        setStatusDetail(message.message);
        return;
      }

      if ("roomCode" in message && message.roomCode !== roomCodeRef.current) return;

      if (message.type === "joined") {
        setStatus("ready");
        setStatusDetail(roleRef.current === "host" ? "Локальная комната открыта" : "Вы в локальной комнате");
        closeAllPeers();
        for (const peer of message.peers) {
          upsertParticipant(peer, { connected: true });
          createPeerConnection(peer);
        }
        publishProfileBurst();
        return;
      }

      if (message.type === "peer-joined") {
        upsertParticipant(message.peer, { connected: true });
        createPeerConnection(message.peer);
        publishProfileBurst();
        return;
      }

      if (message.type === "peer-updated") {
        upsertParticipant(message.peer, { connected: true });
        return;
      }

      if (message.type === "peer-left") {
        removeParticipant(message.peerId);
        return;
      }

      if (message.type === "signal") {
        void handleSignal(message.fromPeerId, message.peer, message.signal);
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
    [
      closeAllPeers,
      createPeerConnection,
      handleSignal,
      publishProfileBurst,
      removeParticipant,
      upsertParticipant
    ]
  );

  const joinRoom = useCallback(
    (nextRoomCode: string, nextRole: Role) => {
      const cleanRoom = sanitizeRoomCode(nextRoomCode) || createRoomCode();
      roomCodeRef.current = cleanRoom;
      roleRef.current = nextRole;
      setRoomCode(cleanRoom);
      setRole(nextRole);
      setJoinCode("");
      updateRoomUrl(cleanRoom);

      const connected = sendSocket({
        type: "join",
        roomCode: cleanRoom,
        peer: selfPeer()
      });

      if (!connected) {
        setStatus("connecting");
        setStatusDetail("Ждем локальный signaling");
      }
    },
    [selfPeer, sendSocket, updateRoomUrl]
  );

  const connectSocket = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN || socketRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }

    setStatus((current) => (current === "booting" ? "connecting" : "reconnecting"));
    setStatusDetail("Подключаемся к локальному signaling");

    const socket = new WebSocket(socketUrl());
    socketRef.current = socket;

    socket.onopen = () => {
      setStatus("ready");
      setStatusDetail("Signaling подключен");
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      joinRoom(roomCodeRef.current || createRoomCode(), roleRef.current);
      heartbeatTimerRef.current = window.setInterval(() => {
        sendSocket({ type: "ping", time: Date.now() });
      }, 15000);
    };

    socket.onmessage = (event) => {
      try {
        handleServerMessage(JSON.parse(event.data) as ServerMessage);
      } catch {
        addSystemMessage("Signaling прислал некорректное сообщение.");
      }
    };

    socket.onclose = () => {
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      if (heartbeatTimerRef.current) {
        window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
      closeAllPeers();
      setStatus("reconnecting");
      setStatusDetail("Signaling отключился, пробуем снова");
      reconnectTimerRef.current = window.setTimeout(connectSocket, RECONNECT_DELAY_MS);
    };

    socket.onerror = () => {
      setStatus("reconnecting");
      setStatusDetail("Локальный signaling недоступен");
    };
  }, [addSystemMessage, closeAllPeers, handleServerMessage, joinRoom, sendSocket, socketUrl]);

  const createNewRoom = useCallback(() => {
    const nextRoomCode = createRoomCode();
    addSystemMessage(`Создана новая комната ${nextRoomCode}.`);
    joinRoom(nextRoomCode, "host");
  }, [addSystemMessage, joinRoom]);

  const retryCurrentRoom = useCallback(() => {
    closeAllPeers();
    connectSocket();
    joinRoom(roomCodeRef.current || roomCode || createRoomCode(), roleRef.current);
  }, [closeAllPeers, connectSocket, joinRoom, roomCode]);

  const joinCurrentRoom = useCallback(() => {
    const cleanJoinCode = sanitizeRoomCode(joinCode);
    if (!cleanJoinCode) {
      showToast("Введите код комнаты");
      return;
    }
    joinRoom(cleanJoinCode, "guest");
  }, [joinCode, joinRoom, showToast]);

  const copyText = useCallback(
    async (text: string, message = "Скопировано") => {
      await navigator.clipboard.writeText(text);
      showToast(message);
    },
    [showToast]
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
          ? { deviceId: { exact: videoDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 } }
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.getAudioTracks().forEach((track) => {
        track.enabled = micEnabled;
      });
      stream.getVideoTracks().forEach((track) => {
        track.enabled = cameraEnabled;
      });

      const previous = localStreamRef.current;
      localStreamRef.current = stream;
      setLocalStream(stream);
      setPreviewStream(screenStreamRef.current ?? stream);
      if (previous && previous !== stream) stopStream(previous);
      await refreshDevices();
      updateOutgoingTracks();
      showToast("Камера и микрофон готовы");
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
    cameraEnabled,
    micEnabled,
    refreshDevices,
    showToast,
    updateOutgoingTracks,
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
    screenStreamRef.current = null;
    setScreenStream(null);
    setPreviewStream(localStreamRef.current);
    setIsSharingScreen(false);
    updateOutgoingTracks();
    showToast("Демонстрация экрана остановлена");
  }, [showToast, updateOutgoingTracks]);

  const startScreenShare = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: false
      });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("Браузер не вернул видеодорожку экрана.");

      track.onended = stopScreenShare;
      screenStreamRef.current = stream;
      setScreenStream(stream);
      setPreviewStream(stream);
      setIsSharingScreen(true);
      updateOutgoingTracks();
      showToast("Демонстрация экрана включена");
    } catch (error) {
      addSystemMessage(
        error instanceof Error
          ? `Не удалось включить экран: ${error.message}`
          : "Не удалось включить демонстрацию экрана."
      );
    }
  }, [addSystemMessage, showToast, stopScreenShare, updateOutgoingTracks]);

  const sendChat = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const text = chatText.trim();
      if (!text) return;

      const message: ChatMessage = {
        id: createId(),
        author: displayNameRef.current.trim() || "Гость",
        text,
        time: Date.now(),
        local: true
      };

      sendSocket({
        type: "chat",
        id: message.id,
        author: message.author,
        text: message.text,
        time: message.time,
        roomCode: roomCodeRef.current
      });
      setMessages((current) => [...current, message]);
      setChatText("");
    },
    [chatText, sendSocket]
  );

  const leaveRoom = useCallback(() => {
    sendSocket({ type: "leave", roomCode: roomCodeRef.current });
    closeAllPeers();
    setStatus("booting");
    setStatusDetail("Комната закрыта локально");
  }, [closeAllPeers, sendSocket]);

  const updateDisplayName = useCallback(
    (nextName: string) => {
      displayNameRef.current = nextName;
      setDisplayName(nextName);
      window.localStorage.setItem(NAME_STORAGE_KEY, nextName);
      publishProfileBurst();
    },
    [publishProfileBurst]
  );

  useEffect(() => {
    addSystemMessage("Локальный режим: сайт и signaling работают с вашего ПК. Камера и микрофон не обязательны.");

    const savedName = window.localStorage.getItem(NAME_STORAGE_KEY);
    if (savedName) {
      setDisplayName(savedName);
      displayNameRef.current = savedName;
    }

    const params = new URLSearchParams(window.location.search);
    const codeFromUrl = sanitizeRoomCode(params.get(ROOM_PARAM) ?? "");
    const initialRoom = codeFromUrl || createRoomCode();
    const initialRole: Role = codeFromUrl ? "guest" : "host";
    roomCodeRef.current = initialRoom;
    roleRef.current = initialRole;
    setRoomCode(initialRoom);
    setRole(initialRole);
    updateRoomUrl(initialRoom);

    void refreshDevices();
    connectSocket();

    return () => {
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      if (heartbeatTimerRef.current) window.clearInterval(heartbeatTimerRef.current);
      socketRef.current?.close();
      closeAllPeers();
      stopStream(screenStreamRef.current);
      stopStream(localStreamRef.current);
    };
  }, [addSystemMessage, closeAllPeers, connectSocket, refreshDevices, updateRoomUrl]);

  useEffect(() => {
    window.localStorage.setItem(NAME_STORAGE_KEY, displayName);
  }, [displayName]);

  return (
    <main className="app-shell">
      <header className="app-topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <Video size={24} />
          </div>
          <div>
            <h1>OnlineCall</h1>
            <p>Локальная комната для звонков через ваш ПК</p>
          </div>
        </div>
        <div className={`connection-banner ${status}`}>
          {status === "ready" ? <Check size={17} /> : status === "error" ? <WifiOff size={17} /> : <Loader2 size={17} className="spin" />}
          <span>
            {statusText(status)}: {statusDetail}
          </span>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <section className="panel room-panel">
            <div className="section-title">
              <h2>Комната</h2>
              {status === "ready" ? <Wifi size={18} /> : <WifiOff size={18} />}
            </div>
            <div className="room-code">{roomCode || "------"}</div>
            <div className="button-row">
              <button className="btn btn-secondary" type="button" onClick={createNewRoom}>
                <Sparkles size={17} />
                Новая
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                disabled={!roomLink}
                onClick={() => copyText(roomLink, "Ссылка скопирована")}
              >
                <Link size={17} />
                Ссылка
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                disabled={!roomCode}
                onClick={() => copyText(roomCode, "Код скопирован")}
              >
                <Copy size={17} />
                Код
              </button>
              <button className="btn btn-secondary" type="button" onClick={retryCurrentRoom}>
                <RefreshCw size={17} />
                Повтор
              </button>
            </div>
          </section>

          <section className="panel">
            <div className="section-title">
              <h2>Профиль</h2>
              <ShieldCheck size={18} />
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
                  placeholder="например k4p9xq"
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

          <section className="panel">
            <div className="section-title">
              <h2>Устройства</h2>
              <Settings2 size={18} />
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
          </section>
        </aside>

        <section className="stage panel">
          <div className="stage-header">
            <div>
              <h2>Комната {roomCode}</h2>
              <p>
                {connectedParticipants.length} подключено, роль: {role === "host" ? "ведущий" : "участник"}
              </p>
            </div>
            <div className="status-pill">
              <span className={`dot ${status === "ready" ? "ready" : ""}`} />
              {statusText(status)}
            </div>
          </div>

          <div className="video-grid">
            <VideoTile
              label={displayName || "Вы"}
              subtitle="вы"
              stream={previewStream}
              muted
              emptyIcon={<CameraOff size={34} />}
              emptyText="Вы без локального видео"
            />
            {participants
              .filter((participant) => participant.remoteStream)
              .map((participant) => (
                <VideoTile
                  key={participant.peerId}
                  label={participant.name}
                  subtitle={participant.connectionState}
                  stream={participant.remoteStream}
                  emptyIcon={<UsersRound size={34} />}
                  emptyText="Ожидаем видео"
                />
              ))}
            {!participants.some((participant) => participant.remoteStream) && (
              <div className="video-tile video-tile-muted">
                <UsersRound size={38} />
                <div>Видео участников появится после включения камеры или экрана</div>
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
              Видео: {getTrackLabel(activeSendStream?.getVideoTracks()[0])}
              <br />
              Аудио: {getTrackLabel(localStream?.getAudioTracks()[0])}
            </div>
          </footer>
        </section>

        <aside className="side-panel">
          <section className="panel participants-panel">
            <div className="section-title">
              <h2>Участники</h2>
              <UsersRound size={18} />
            </div>
            <div className="participant-list">
              <ParticipantRow
                name={`${displayName || "Вы"} (вы)`}
                role={role}
                connected={status === "ready"}
                state="local"
              />
              {participants.length ? (
                participants.map((participant) => (
                  <ParticipantRow
                    key={participant.peerId}
                    name={participant.name}
                    role={participant.role}
                    connected={participant.connected}
                    state={participant.connectionState}
                  />
                ))
              ) : (
                <div className="empty-state">
                  <UsersRound size={30} />
                  <div>Пока никого нет</div>
                </div>
              )}
            </div>
          </section>

          <section className="panel chat-panel">
            <div className="section-title">
              <h2>Чат</h2>
              <MessageSquareText size={18} />
            </div>
            <div className="chat-log" aria-live="polite">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`message ${message.local ? "local" : ""} ${message.system ? "system" : ""}`}
                >
                  <div className="message-meta">
                    <span>{message.author}</span>
                    <span>{formatTime(message.time)}</span>
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
        </aside>
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
    </main>
  );
}

function VideoTile({
  label,
  subtitle,
  stream,
  muted,
  emptyIcon,
  emptyText
}: {
  label: string;
  subtitle: string;
  stream: MediaStream | null;
  muted?: boolean;
  emptyIcon: React.ReactNode;
  emptyText: string;
}) {
  return (
    <div className="video-tile">
      {stream ? (
        <VideoElement stream={stream} muted={muted} />
      ) : (
        <div className="video-placeholder">
          {emptyIcon}
          <div>{emptyText}</div>
        </div>
      )}
      <div className="tile-badge">
        <UserRound size={15} />
        <span>{label}</span>
        <small>{subtitle}</small>
      </div>
    </div>
  );
}

function ParticipantRow({
  name,
  role,
  connected,
  state
}: {
  name: string;
  role: Role;
  connected: boolean;
  state: string;
}) {
  return (
    <div className="participant-row">
      <div className="participant-avatar">
        <UserRound size={17} />
      </div>
      <div className="participant-meta">
        <strong>{name}</strong>
        <span>{role === "host" ? "ведущий" : "участник"} · {state}</span>
      </div>
      <span className={`badge ${connected ? "connected" : "waiting"}`}>
        {connected ? "онлайн" : "ожидание"}
      </span>
    </div>
  );
}
