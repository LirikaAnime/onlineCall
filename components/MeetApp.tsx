"use client";

import {
  AlertTriangle,
  Camera,
  CameraOff,
  Check,
  Clipboard,
  Copy,
  Link,
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
  Trash2,
  UserRound,
  UsersRound,
  Video
} from "lucide-react";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  attachLocalMedia,
  createRtcConfig,
  getTrackLabel,
  IceMode,
  mergeTrackIntoStream,
  PeerWiring,
  replaceSenderTrack,
  stopStream,
  waitForIceGatheringComplete
} from "@/lib/webrtc";
import {
  createParticipantId,
  createRoomId,
  decodeSignal,
  encodeSignal,
  SignalPayload,
  summarizeCode
} from "@/lib/signaling-code";

type PeerStatus =
  | "new"
  | "preparing"
  | "waiting-answer"
  | "answer-ready"
  | "connecting"
  | "connected"
  | "closed"
  | "failed";

type PeerRecord = {
  id: string;
  label: string;
  remoteName?: string;
  sessionRoomId?: string;
  remoteParticipantId?: string;
  status: PeerStatus;
  connectionState: RTCPeerConnectionState | "idle";
  iceState: RTCIceConnectionState | "idle";
  outgoingCode: string;
  incomingCode: string;
  error?: string;
  dataOpen: boolean;
  remoteStream: MediaStream | null;
};

type PeerRuntime = {
  connection: RTCPeerConnection;
  channel?: RTCDataChannel;
  wiring: PeerWiring;
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

type WireMessage =
  | {
      type: "presence";
      participantId: string;
      name: string;
      roomId: string;
    }
  | {
      type: "chat";
      id: string;
      author: string;
      text: string;
      time: number;
    };

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

function createPeerLabel(index: number) {
  return `Участник ${index}`;
}

function createPeer(index: number, id = createParticipantId()): PeerRecord {
  return {
    id,
    label: createPeerLabel(index),
    status: "new",
    connectionState: "idle",
    iceState: "idle",
    outgoingCode: "",
    incomingCode: "",
    dataOpen: false,
    remoteStream: null
  };
}

function statusLabel(status: PeerStatus) {
  switch (status) {
    case "new":
      return "новый";
    case "preparing":
      return "готовится";
    case "waiting-answer":
      return "ждет answer";
    case "answer-ready":
      return "answer готов";
    case "connecting":
      return "соединяется";
    case "connected":
      return "соединен";
    case "closed":
      return "закрыт";
    case "failed":
      return "ошибка";
  }
}

function statusClass(status: PeerStatus) {
  if (status === "connected") return "connected";
  if (status === "failed" || status === "closed") return "failed";
  if (status === "waiting-answer" || status === "answer-ready" || status === "connecting") {
    return "waiting";
  }
  return "";
}

function formatTime(value: number) {
  if (!value) {
    return "--:--";
  }

  return new Intl.DateTimeFormat("ru", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(value);
}

function safeJsonParse(value: string): WireMessage | null {
  try {
    const parsed = JSON.parse(value) as Partial<WireMessage>;
    if (parsed.type === "presence" || parsed.type === "chat") {
      return parsed as WireMessage;
    }
  } catch {
    return null;
  }

  return null;
}

function VideoElement({
  stream,
  muted,
  className
}: {
  stream: MediaStream | null;
  muted?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) {
      ref.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <video
      ref={ref}
      className={className}
      autoPlay
      playsInline
      muted={muted}
    />
  );
}

export function MeetApp() {
  const [participantId, setParticipantId] = useState("local");
  const [displayName, setDisplayName] = useState("Гость");
  const [roomId, setRoomId] = useState("");
  const [iceMode, setIceMode] = useState<IceMode>("public-stun");
  const [peers, setPeers] = useState<PeerRecord[]>(() => [createPeer(1, "peer-1")]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [devices, setDevices] = useState<DeviceLists>({ audioInputs: [], videoInputs: [] });
  const [audioDeviceId, setAudioDeviceId] = useState("");
  const [videoDeviceId, setVideoDeviceId] = useState("");
  const [chatText, setChatText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      author: "Manual Meet",
      text: "Сначала включите камеру и микрофон, затем обменяйтесь кодами подключения с собеседником.",
      time: 0,
      system: true
    }
  ]);
  const [toast, setToast] = useState("");

  const runtimes = useRef(new Map<string, PeerRuntime>());
  const peersRef = useRef(peers);
  const localStreamRef = useRef(localStream);
  const screenStreamRef = useRef(screenStream);
  const displayNameRef = useRef(displayName);
  const roomIdRef = useRef(roomId);
  const iceModeRef = useRef(iceMode);

  const setDisplayNameValue = useCallback((value: string) => {
    displayNameRef.current = value;
    setDisplayName(value);
  }, []);

  const setRoomIdValue = useCallback((value: string) => {
    roomIdRef.current = value;
    setRoomId(value);
  }, []);

  const setIceModeValue = useCallback((value: IceMode) => {
    iceModeRef.current = value;
    setIceMode(value);
  }, []);

  const syncRoomUrl = useCallback((nextRoomId: string) => {
    if (typeof window === "undefined" || !nextRoomId) {
      return;
    }

    const url = new URL(window.location.href);
    url.searchParams.set("room", nextRoomId);
    window.history.replaceState(null, "", url.toString());
  }, []);

  useEffect(() => {
    peersRef.current = peers;
  }, [peers]);

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  useEffect(() => {
    screenStreamRef.current = screenStream;
  }, [screenStream]);

  useEffect(() => {
    displayNameRef.current = displayName;
  }, [displayName]);

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  useEffect(() => {
    iceModeRef.current = iceMode;
  }, [iceMode]);

  const connectedPeers = peers.filter((peer) => peer.status === "connected").length;
  const openChannels = peers.filter((peer) => peer.dataOpen).length;
  const hasLocalMedia = Boolean(localStream);

  const roomLink = useMemo(() => {
    if (typeof window === "undefined") {
      return "";
    }

    const url = new URL(window.location.href);
    url.searchParams.set("room", roomId);
    return url.toString();
  }, [roomId]);

  const showToast = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const addSystemMessage = useCallback((text: string) => {
    setMessages((current) => [
      ...current,
      {
        id: createParticipantId(),
        author: "Manual Meet",
        text,
        time: Date.now(),
        system: true
      }
    ]);
  }, []);

  const patchPeer = useCallback((peerId: string, patch: Partial<PeerRecord>) => {
    setPeers((current) =>
      current.map((peer) => (peer.id === peerId ? { ...peer, ...patch } : peer))
    );
  }, []);

  const closeRuntime = useCallback((peerId: string) => {
    const runtime = runtimes.current.get(peerId);
    if (runtime) {
      runtime.connection.ontrack = null;
      runtime.connection.onconnectionstatechange = null;
      runtime.connection.oniceconnectionstatechange = null;
      runtime.connection.ondatachannel = null;
      if (runtime.channel) {
        runtime.channel.onopen = null;
        runtime.channel.onclose = null;
        runtime.channel.onerror = null;
        runtime.channel.onmessage = null;
      }
    }
    runtime?.channel?.close();
    runtime?.connection.close();
    runtimes.current.delete(peerId);
  }, []);

  const copyText = useCallback(
    async (text: string, message = "Скопировано") => {
      await navigator.clipboard.writeText(text);
      showToast(message);
    },
    [showToast]
  );

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    const allDevices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = allDevices.filter((device) => device.kind === "audioinput");
    const videoInputs = allDevices.filter((device) => device.kind === "videoinput");
    setDevices({ audioInputs, videoInputs });
    setAudioDeviceId((current) => current || audioInputs[0]?.deviceId || "");
    setVideoDeviceId((current) => current || videoInputs[0]?.deviceId || "");
  }, []);

  const broadcast = useCallback(
    (message: WireMessage) => {
      const payload = JSON.stringify(message);
      runtimes.current.forEach((runtime) => {
        if (runtime.channel?.readyState === "open") {
          runtime.channel.send(payload);
        }
      });
    },
    []
  );

  const sendPresence = useCallback(
    (runtime: PeerRuntime) => {
      if (runtime.channel?.readyState !== "open") {
        return;
      }

      runtime.channel.send(
        JSON.stringify({
          type: "presence",
          participantId,
          name: displayNameRef.current,
          roomId: roomIdRef.current
        } satisfies WireMessage)
      );
    },
    [participantId]
  );

  const wireDataChannel = useCallback(
    (peerId: string, runtime: PeerRuntime, channel: RTCDataChannel) => {
      runtime.channel = channel;
      channel.binaryType = "arraybuffer";

      channel.onopen = () => {
        patchPeer(peerId, { dataOpen: true });
        sendPresence(runtime);
      };

      channel.onclose = () => {
        patchPeer(peerId, { dataOpen: false });
      };

      channel.onerror = () => {
        patchPeer(peerId, {
          error: "DataChannel сообщил об ошибке. Чат может не работать."
        });
      };

      channel.onmessage = (event: MessageEvent<string>) => {
        const message = safeJsonParse(event.data);
        if (!message) {
          return;
        }

        if (message.type === "presence") {
          patchPeer(peerId, { remoteName: message.name });
          return;
        }

        setMessages((current) => [
          ...current,
          {
            id: message.id,
            author: message.author,
            text: message.text,
            time: message.time
          }
        ]);
      };
    },
    [patchPeer, sendPresence]
  );

  const syncRuntimeTracks = useCallback(async (runtime: PeerRuntime) => {
    const audioTrack = localStreamRef.current?.getAudioTracks()[0] ?? null;
    const videoTrack =
      screenStreamRef.current?.getVideoTracks()[0] ??
      localStreamRef.current?.getVideoTracks()[0] ??
      null;

    await Promise.all([
      replaceSenderTrack(runtime.wiring.audioSender, audioTrack),
      replaceSenderTrack(runtime.wiring.videoSender, videoTrack)
    ]);
  }, []);

  const createRuntime = useCallback(
    (peerId: string) => {
      const connection = new RTCPeerConnection(createRtcConfig(iceModeRef.current));
      const wiring = attachLocalMedia(connection, localStreamRef.current);
      const runtime: PeerRuntime = { connection, wiring };

      connection.ontrack = (event) => {
        const existing = peersRef.current.find((peer) => peer.id === peerId)?.remoteStream ?? null;
        const remoteStream = mergeTrackIntoStream(existing, event);
        patchPeer(peerId, { remoteStream });
      };

      connection.onconnectionstatechange = () => {
        const state = connection.connectionState;
        patchPeer(peerId, {
          connectionState: state,
          status:
            state === "connected"
              ? "connected"
              : state === "failed" || state === "closed" || state === "disconnected"
                ? "failed"
                : "connecting"
        });
      };

      connection.oniceconnectionstatechange = () => {
        patchPeer(peerId, { iceState: connection.iceConnectionState });
      };

      connection.ondatachannel = (event) => {
        wireDataChannel(peerId, runtime, event.channel);
      };

      runtimes.current.set(peerId, runtime);
      return runtime;
    },
    [patchPeer, wireDataChannel]
  );

  const getRuntime = useCallback(
    (peerId: string) => runtimes.current.get(peerId) ?? createRuntime(peerId),
    [createRuntime]
  );

  const buildSignal = useCallback(
    (type: "offer" | "answer", description: RTCSessionDescriptionInit) =>
      encodeSignal({
        version: 1,
        type,
        roomId: roomIdRef.current,
        participantId,
        participantName: displayNameRef.current.trim() || "Гость",
        createdAt: Date.now(),
        description
      }),
    [participantId]
  );

  const createOffer = useCallback(
    async (peerId: string) => {
      try {
        closeRuntime(peerId);
        patchPeer(peerId, {
          status: "preparing",
          connectionState: "idle",
          iceState: "idle",
          error: "",
          outgoingCode: "",
          incomingCode: "",
          dataOpen: false,
          remoteStream: null,
          remoteName: undefined,
          remoteParticipantId: undefined,
          sessionRoomId: roomIdRef.current
        });
        const runtime = getRuntime(peerId);
        await syncRuntimeTracks(runtime);
        const channel = runtime.connection.createDataChannel("manual-meet-chat", {
          ordered: true
        });
        wireDataChannel(peerId, runtime, channel);

        const offer = await runtime.connection.createOffer();
        await runtime.connection.setLocalDescription(offer);
        await waitForIceGatheringComplete(runtime.connection);

        if (!runtime.connection.localDescription) {
          throw new Error("Браузер не создал offer.");
        }

        const code = buildSignal("offer", runtime.connection.localDescription.toJSON());
        patchPeer(peerId, {
          outgoingCode: code,
          sessionRoomId: roomIdRef.current,
          status: "waiting-answer",
          connectionState: runtime.connection.connectionState,
          iceState: runtime.connection.iceConnectionState
        });
        showToast("Offer готов. Отправьте код собеседнику.");
      } catch (error) {
        patchPeer(peerId, {
          status: "failed",
          error: error instanceof Error ? error.message : "Не удалось создать offer."
        });
      }
    },
    [
      buildSignal,
      closeRuntime,
      getRuntime,
      patchPeer,
      showToast,
      syncRuntimeTracks,
      wireDataChannel
    ]
  );

  const applySignal = useCallback(
    async (peerId: string) => {
      const peer = peersRef.current.find((item) => item.id === peerId);
      if (!peer) {
        return;
      }

      try {
        const signal = decodeSignal(peer.incomingCode);
        const currentRoomId = roomIdRef.current;
        const expectedRoomId = peer.sessionRoomId || currentRoomId;

        if (signal.type === "offer") {
          closeRuntime(peerId);
        }

        if (signal.type === "offer" && signal.roomId !== currentRoomId) {
          setRoomIdValue(signal.roomId);
          syncRoomUrl(signal.roomId);
          addSystemMessage(`Комната переключена на ${signal.roomId} из offer-кода.`);
        }

        if (signal.type === "answer" && signal.roomId !== expectedRoomId) {
          throw new Error(
            `Answer относится к комнате ${signal.roomId}, а этот peer ждет ${expectedRoomId}.`
          );
        }

        patchPeer(peerId, {
          status: "connecting",
          connectionState: "idle",
          iceState: "idle",
          error: "",
          outgoingCode: signal.type === "offer" ? "" : peer.outgoingCode,
          remoteName: signal.participantName,
          remoteParticipantId: signal.participantId,
          sessionRoomId: signal.roomId,
          dataOpen: false,
          remoteStream: signal.type === "offer" ? null : peer.remoteStream
        });

        const runtime = getRuntime(peerId);
        await syncRuntimeTracks(runtime);

        if (signal.type === "offer") {
          await runtime.connection.setRemoteDescription(signal.description);
          const answer = await runtime.connection.createAnswer();
          await runtime.connection.setLocalDescription(answer);
          await waitForIceGatheringComplete(runtime.connection);

          if (!runtime.connection.localDescription) {
            throw new Error("Браузер не создал answer.");
          }

          const code = buildSignal("answer", runtime.connection.localDescription.toJSON());
          patchPeer(peerId, {
            outgoingCode: code,
            status: "answer-ready",
            connectionState: runtime.connection.connectionState,
            iceState: runtime.connection.iceConnectionState
          });
          showToast("Answer готов. Отправьте код обратно.");
          return;
        }

        if (runtime.connection.signalingState === "stable") {
          throw new Error("Этот peer уже имеет стабильное соединение.");
        }

        await runtime.connection.setRemoteDescription(signal.description);
        patchPeer(peerId, {
          status: "connecting",
          connectionState: runtime.connection.connectionState,
          iceState: runtime.connection.iceConnectionState
        });
        showToast("Answer принят. Соединение запускается.");
      } catch (error) {
        patchPeer(peerId, {
          status: "failed",
          error: error instanceof Error ? error.message : "Не удалось применить код."
        });
      }
    },
    [
      addSystemMessage,
      buildSignal,
      closeRuntime,
      getRuntime,
      patchPeer,
      setRoomIdValue,
      showToast,
      syncRoomUrl,
      syncRuntimeTracks
    ]
  );

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
      setPreviewStream(isSharingScreen ? screenStreamRef.current : stream);
      await refreshDevices();

      const audioTrack = stream.getAudioTracks()[0] ?? null;
      const videoTrack = stream.getVideoTracks()[0] ?? null;
      await Promise.all(
        Array.from(runtimes.current.values()).flatMap((runtime) => [
          replaceSenderTrack(runtime.wiring.audioSender, audioTrack),
          isSharingScreen
            ? Promise.resolve()
            : replaceSenderTrack(runtime.wiring.videoSender, videoTrack)
        ])
      );

      if (previous && previous !== stream) {
        stopStream(previous);
      }

      showToast("Камера и микрофон готовы.");
    } catch (error) {
      addSystemMessage(
        error instanceof Error
          ? `Не удалось получить доступ к медиа: ${error.message}`
          : "Не удалось получить доступ к камере или микрофону."
      );
    }
  }, [
    addSystemMessage,
    audioDeviceId,
    cameraEnabled,
    isSharingScreen,
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

  const stopScreenShare = useCallback(async () => {
    const cameraTrack = localStreamRef.current?.getVideoTracks()[0] ?? null;
    await Promise.all(
      Array.from(runtimes.current.values()).map((runtime) =>
        replaceSenderTrack(runtime.wiring.videoSender, cameraTrack)
      )
    );
    stopStream(screenStreamRef.current);
    setScreenStream(null);
    setPreviewStream(localStreamRef.current);
    setIsSharingScreen(false);
    showToast("Демонстрация экрана остановлена.");
  }, [showToast]);

  const startScreenShare = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 30 }
        },
        audio: false
      });
      const screenTrack = stream.getVideoTracks()[0];
      if (!screenTrack) {
        throw new Error("Браузер не вернул видеодорожку экрана.");
      }

      screenTrack.onended = () => {
        void stopScreenShare();
      };

      await Promise.all(
        Array.from(runtimes.current.values()).map((runtime) =>
          replaceSenderTrack(runtime.wiring.videoSender, screenTrack)
        )
      );

      setScreenStream(stream);
      setPreviewStream(stream);
      setIsSharingScreen(true);
      showToast("Демонстрация экрана включена.");
    } catch (error) {
      addSystemMessage(
        error instanceof Error
          ? `Не удалось включить экран: ${error.message}`
          : "Не удалось включить демонстрацию экрана."
      );
    }
  }, [addSystemMessage, showToast, stopScreenShare]);

  const hangUp = useCallback(() => {
    runtimes.current.forEach((runtime) => {
      runtime.channel?.close();
      runtime.connection.close();
    });
    runtimes.current.clear();
    stopStream(screenStreamRef.current);
    stopStream(localStreamRef.current);
    setLocalStream(null);
    setPreviewStream(null);
    setScreenStream(null);
    setIsSharingScreen(false);
    setPeers([createPeer(1, "peer-1")]);
    addSystemMessage("Звонок завершен локально.");
  }, [addSystemMessage]);

  const removePeer = useCallback(
    (peerId: string) => {
      closeRuntime(peerId);
      setPeers((current) =>
        current.length === 1
          ? [createPeer(1, "peer-1")]
          : current.filter((peer) => peer.id !== peerId)
      );
    },
    [closeRuntime]
  );

  const addPeer = useCallback(() => {
    setPeers((current) => [...current, createPeer(current.length + 1)]);
  }, []);

  const createNewRoom = useCallback(() => {
    const nextRoomId = createRoomId();
    setRoomIdValue(nextRoomId);
    syncRoomUrl(nextRoomId);
    showToast("Создана новая секретная ссылка.");
  }, [setRoomIdValue, showToast, syncRoomUrl]);

  const submitChat = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const text = chatText.trim();
      if (!text) {
        return;
      }

      const message = {
        type: "chat",
        id: createParticipantId(),
        author: displayNameRef.current.trim() || "Гость",
        text,
        time: Date.now()
      } satisfies WireMessage;

      broadcast(message);
      setMessages((current) => [...current, { ...message, local: true }]);
      setChatText("");
    },
    [broadcast, chatText]
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const savedParticipantId = window.sessionStorage.getItem("manual-meet-participant-id");
    const nextParticipantId = savedParticipantId || createParticipantId();
    window.sessionStorage.setItem("manual-meet-participant-id", nextParticipantId);
    setParticipantId(nextParticipantId);

    const roomFromUrl = params.get("room");
    if (roomFromUrl) {
      setRoomIdValue(roomFromUrl);
    } else {
      const nextRoomId = createRoomId();
      setRoomIdValue(nextRoomId);
      syncRoomUrl(nextRoomId);
    }

    const savedName = window.localStorage.getItem("manual-meet-name");
    if (savedName) {
      setDisplayNameValue(savedName);
    }

    void refreshDevices();

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register(`${basePath}/sw.js`).catch(() => undefined);
      });
    }

    return () => {
      runtimes.current.forEach((runtime) => {
        runtime.channel?.close();
        runtime.connection.close();
      });
      runtimes.current.clear();
      stopStream(screenStreamRef.current);
      stopStream(localStreamRef.current);
    };
  }, [refreshDevices, setDisplayNameValue, setRoomIdValue, syncRoomUrl]);

  useEffect(() => {
    window.localStorage.setItem("manual-meet-name", displayName);
    runtimes.current.forEach(sendPresence);
  }, [displayName, sendPresence]);

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
                  <h1 className="brand-title">Manual Meet</h1>
                  <p className="brand-subtitle">Созвоны без сервера на GitHub Pages</p>
                </div>
              </div>
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
                  onChange={(event) => setDisplayNameValue(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="roomId">Секретная комната</label>
                <div className="copy-row">
                  <input
                    id="roomId"
                    className="input"
                    value={roomId}
                    onChange={(event) => {
                      const nextRoomId = event.target.value.trim();
                      setRoomIdValue(nextRoomId);
                      syncRoomUrl(nextRoomId);
                    }}
                  />
                  <button
                    className="icon-btn"
                    type="button"
                    title="Скопировать ссылку"
                    onClick={() => copyText(roomLink, "Ссылка комнаты скопирована")}
                  >
                    <Link size={18} />
                  </button>
                </div>
              </div>
              <div className="button-row">
                <button className="btn btn-secondary" type="button" onClick={createNewRoom}>
                  <RefreshCw size={17} />
                  Новая
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => copyText(roomLink, "Ссылка комнаты скопирована")}
                >
                  <Copy size={17} />
                  Ссылка
                </button>
              </div>
              <p className="helper">
                Ссылка открывает ту же комнату, но не заменяет обмен кодами. Камера и микрофон
                необязательны: можно подключиться как слушатель или только для чата.
              </p>
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
              <div className="field">
                <label htmlFor="iceMode">Сеть</label>
                <select
                  id="iceMode"
                  className="select"
                  value={iceMode}
                  onChange={(event) => setIceModeValue(event.target.value as IceMode)}
                >
                  <option value="public-stun">Публичный STUN для интернета</option>
                  <option value="local-only">Только локальная сеть</option>
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

            <section className="section">
              <div className="notice">
                <AlertTriangle size={18} aria-hidden="true" />
                <div>
                  <strong>Без сервера работает честно, но вручную.</strong>
                  Для каждого собеседника нужно обменяться offer/answer кодами через любой личный
                  канал. Короткий код в карточке - это 50-символьное превью; для подключения нужен
                  полный код, потому что в нем лежат WebRTC-параметры.
                </div>
              </div>
            </section>
          </div>
        </aside>

        <section className="stage panel">
          <header className="topbar">
            <div className="room-title">
              <h1>Комната {roomId}</h1>
              <p>
                {connectedPeers} подключено, {openChannels} чат-каналов открыто
              </p>
            </div>
            <div className="status-pill">
              <span className={`dot ${hasLocalMedia ? "ready" : ""}`} />
              {hasLocalMedia ? "медиа готово" : "медиа не включено"}
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
                    <div>Локальное видео пока выключено</div>
                  </div>
                </div>
              )}
              <div className="tile-badge">
                <UserRound size={15} />
                <span>{displayName || "Вы"}</span>
              </div>
            </div>

            {peers
              .filter((peer) => peer.remoteStream)
              .map((peer) => (
                <div className="video-tile" key={peer.id}>
                  <VideoElement stream={peer.remoteStream} />
                  <div className="tile-badge">
                    <UsersRound size={15} />
                    <span>{peer.remoteName || peer.label}</span>
                  </div>
                </div>
              ))}

            {!peers.some((peer) => peer.remoteStream) && (
              <div className="video-tile">
                <div className="video-placeholder">
                  <div>
                    <UsersRound size={34} />
                    <div>Удаленные участники появятся после обмена кодами</div>
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
              <button className="control-btn danger" type="button" title="Завершить" onClick={hangUp}>
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
                <h2>Подключения</h2>
                <button className="icon-btn" type="button" title="Добавить участника" onClick={addPeer}>
                  <Plus size={18} />
                </button>
              </div>
              <div className="peer-list">
                {peers.map((peer, index) => (
                  <PeerCard
                    key={peer.id}
                    peer={peer}
                    index={index}
                    onCreateOffer={createOffer}
                    onApplySignal={applySignal}
                    onPatch={patchPeer}
                    onCopy={copyText}
                    onRemove={removePeer}
                  />
                ))}
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
                {messages.length === 0 ? (
                  <div className="empty-state">
                    <div>
                      <MessageSquareText size={30} />
                      <div>Сообщений пока нет</div>
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
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
                  ))
                )}
              </div>
              <form className="chat-form" onSubmit={submitChat}>
                <input
                  className="input"
                  value={chatText}
                  onChange={(event) => setChatText(event.target.value)}
                  placeholder={openChannels ? "Сообщение всем открытым каналам" : "Чат откроется после соединения"}
                  disabled={!openChannels}
                />
                <button className="btn btn-primary" type="submit" disabled={!openChannels || !chatText.trim()}>
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

function PeerCard({
  peer,
  index,
  onCreateOffer,
  onApplySignal,
  onPatch,
  onCopy,
  onRemove
}: {
  peer: PeerRecord;
  index: number;
  onCreateOffer: (peerId: string) => Promise<void>;
  onApplySignal: (peerId: string) => Promise<void>;
  onPatch: (peerId: string, patch: Partial<PeerRecord>) => void;
  onCopy: (text: string, message?: string) => Promise<void>;
  onRemove: (peerId: string) => void;
}) {
  const connectionDetails =
    peer.connectionState === "idle"
      ? "нет peer connection"
      : `${peer.connectionState}, ICE: ${peer.iceState}`;

  return (
    <article className="peer-card">
      <header className="peer-card-header">
        <div className="peer-name">
          <strong>{peer.remoteName || peer.label || `Участник ${index + 1}`}</strong>
          <span className="status-text">{connectionDetails}</span>
        </div>
        <span className={`badge ${statusClass(peer.status)}`}>
          {peer.status === "connected" ? <Check size={13} /> : null}
          {statusLabel(peer.status)}
        </span>
      </header>
      <div className="peer-body">
        <div className="small-grid">
          <button
            className="btn btn-primary"
            type="button"
            disabled={peer.status === "preparing" || peer.status === "connected"}
            onClick={() => onCreateOffer(peer.id)}
          >
            <Clipboard size={16} />
            Создать offer
          </button>
          <button className="btn btn-danger" type="button" onClick={() => onRemove(peer.id)}>
            <Trash2 size={16} />
            Удалить
          </button>
        </div>

        <div className="field">
          <label htmlFor={`out-${peer.id}`}>Ваш код для собеседника</label>
          <textarea
            id={`out-${peer.id}`}
            className="textarea"
            value={peer.outgoingCode}
            readOnly
            placeholder="Здесь появится offer или answer"
          />
          <div className="copy-row">
            <input
              className="input"
              value={peer.outgoingCode ? summarizeCode(peer.outgoingCode) : ""}
              readOnly
              placeholder="Короткое превью, 50 символов"
            />
            <button
              className="icon-btn"
              type="button"
              title="Скопировать код"
              disabled={!peer.outgoingCode}
              onClick={() => onCopy(peer.outgoingCode, "Код подключения скопирован")}
            >
              <Copy size={18} />
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor={`in-${peer.id}`}>Код от собеседника</label>
          <textarea
            id={`in-${peer.id}`}
            className="textarea"
            value={peer.incomingCode}
            placeholder="Вставьте offer или answer"
            onChange={(event) => onPatch(peer.id, { incomingCode: event.target.value })}
          />
          <button
            className="btn btn-secondary"
            type="button"
            disabled={!peer.incomingCode.trim()}
            onClick={() => onApplySignal(peer.id)}
          >
            <Check size={16} />
            Применить код
          </button>
        </div>

        {peer.error ? <p className="helper">Ошибка: {peer.error}</p> : null}
        <p className="helper">
          1-на-1: создатель жмет <span className="kbd">offer</span>, второй вставляет его и
          возвращает <span className="kbd">answer</span>. Для группы повторите это с каждым
          участником отдельно.
        </p>
      </div>
    </article>
  );
}
