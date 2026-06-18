import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";

export type SignalType = "offer" | "answer";

export type SignalPayload = {
  version: 1;
  type: SignalType;
  roomId: string;
  participantId: string;
  participantName: string;
  createdAt: number;
  description: RTCSessionDescriptionInit;
};

const CODE_PREFIX = "manual-meet-v1.";

export function encodeSignal(payload: SignalPayload): string {
  const serialized = JSON.stringify(payload);
  return `${CODE_PREFIX}${compressToEncodedURIComponent(serialized)}`;
}

export function decodeSignal(code: string): SignalPayload {
  const normalized = code.trim();
  if (!normalized.startsWith(CODE_PREFIX)) {
    throw new Error("Код должен начинаться с manual-meet-v1.");
  }

  const compressed = normalized.slice(CODE_PREFIX.length);
  const json = decompressFromEncodedURIComponent(compressed);
  if (!json) {
    throw new Error("Не удалось распаковать код подключения.");
  }

  const parsed = JSON.parse(json) as Partial<SignalPayload>;
  if (
    parsed.version !== 1 ||
    (parsed.type !== "offer" && parsed.type !== "answer") ||
    !parsed.roomId ||
    !parsed.participantId ||
    !parsed.participantName ||
    !parsed.description ||
    (parsed.description.type !== "offer" && parsed.description.type !== "answer") ||
    !parsed.description.sdp
  ) {
    throw new Error("Код подключения поврежден или создан другой версией приложения.");
  }

  return parsed as SignalPayload;
}

export function createParticipantId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 8);
  }

  return Math.random().toString(36).slice(2, 10);
}

export function createRoomId(): string {
  const bytes = new Uint8Array(9);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  return Array.from(bytes)
    .map((byte) => byte.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export function summarizeCode(code: string): string {
  const clean = code.trim();
  if (clean.length <= 26) {
    return clean;
  }

  return `${clean.slice(0, 14)}...${clean.slice(-8)}`;
}
