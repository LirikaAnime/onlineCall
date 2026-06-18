export type IceMode = "public-stun" | "local-only";

export type PeerWiring = {
  audioSender?: RTCRtpSender;
  videoSender?: RTCRtpSender;
};

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];

export function createRtcConfig(mode: IceMode): RTCConfiguration {
  return {
    bundlePolicy: "balanced",
    iceCandidatePoolSize: 4,
    iceServers: mode === "public-stun" ? DEFAULT_ICE_SERVERS : []
  };
}

export function attachLocalMedia(
  connection: RTCPeerConnection,
  localStream: MediaStream | null
): PeerWiring {
  const audioTrack = localStream?.getAudioTracks()[0] ?? null;
  const videoTrack = localStream?.getVideoTracks()[0] ?? null;
  const wiring: PeerWiring = {};

  if (audioTrack && localStream) {
    wiring.audioSender = connection.addTrack(audioTrack, localStream);
  } else {
    wiring.audioSender = connection.addTransceiver("audio", {
      direction: "sendrecv"
    }).sender;
  }

  if (videoTrack && localStream) {
    wiring.videoSender = connection.addTrack(videoTrack, localStream);
  } else {
    wiring.videoSender = connection.addTransceiver("video", {
      direction: "sendrecv"
    }).sender;
  }

  return wiring;
}

export async function waitForIceGatheringComplete(
  connection: RTCPeerConnection,
  timeoutMs = 14000
): Promise<void> {
  if (connection.iceGatheringState === "complete") {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(done, timeoutMs);

    function done() {
      window.clearTimeout(timeout);
      connection.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    }

    function onStateChange() {
      if (connection.iceGatheringState === "complete") {
        done();
      }
    }

    connection.addEventListener("icegatheringstatechange", onStateChange);
  });
}

export function mergeTrackIntoStream(stream: MediaStream | null, event: RTCTrackEvent): MediaStream {
  const target = event.streams[0] ?? stream ?? new MediaStream();
  if (!target.getTracks().some((track) => track.id === event.track.id)) {
    target.addTrack(event.track);
  }

  return target;
}

export function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

export function getTrackLabel(track: MediaStreamTrack | undefined) {
  return track?.label || "устройство не выбрано";
}

export async function replaceSenderTrack(
  sender: RTCRtpSender | undefined,
  track: MediaStreamTrack | null
) {
  if (!sender) {
    return;
  }

  await sender.replaceTrack(track);
}
