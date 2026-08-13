/**
 * Espelho do protocolo definido em `backend/signaling/models.py`.
 * Qualquer mudança aqui precisa acompanhar o backend.
 */

export interface RoomView {
  id: string;
  name: string;
  host_nick: string | null;
  occupants: number;
  capacity: number;
  created_at: number;
}

export interface PeerView {
  nick: string;
  public_key: string;
  role: 'host' | 'guest';
}

/** SDP e ICE trafegam opacos pelo servidor. */
export interface SignalPayload {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

// -- cliente -> servidor -----------------------------------------------------

export interface CreateRoomMessage {
  type: 'create_room';
  name: string;
  nick: string;
  public_key: string;
  room_id?: string;
}

export interface JoinRoomMessage {
  type: 'join_room';
  room_id: string;
  nick: string;
  public_key: string;
}

export interface SignalMessage {
  type: 'signal';
  data: SignalPayload;
}

export interface LeaveMessage {
  type: 'leave';
}

export interface PingMessage {
  type: 'ping';
}

export type ClientMessage =
  | CreateRoomMessage
  | JoinRoomMessage
  | SignalMessage
  | LeaveMessage
  | PingMessage;

// -- servidor -> cliente -----------------------------------------------------

export interface RoomCreatedMessage {
  type: 'room_created';
  room: RoomView;
  self: PeerView;
}

export interface RoomJoinedMessage {
  type: 'room_joined';
  room: RoomView;
  self: PeerView;
  peer: PeerView | null;
}

export interface PeerJoinedMessage {
  type: 'peer_joined';
  peer: PeerView;
}

export interface PeerLeftMessage {
  type: 'peer_left';
  nick: string;
}

export interface SignalRelayMessage {
  type: 'signal';
  from: string;
  data: SignalPayload;
}

export interface ErrorMessage {
  type: 'error';
  code: SignalingErrorCode;
  message: string;
}

export interface PongMessage {
  type: 'pong';
}

export type SignalingErrorCode =
  | 'room_not_found'
  | 'room_full'
  | 'nick_taken'
  | 'not_in_room'
  | 'invalid_message'
  | 'signaling_error';

export type ServerMessage =
  | RoomCreatedMessage
  | RoomJoinedMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | SignalRelayMessage
  | ErrorMessage
  | PongMessage;

/** Mesma regra do backend, para dar retorno antes do round-trip. */
export const NICK_PATTERN = /^[\w][\w .-]{1,23}$/u;

export function isValidNick(nick: string): boolean {
  return NICK_PATTERN.test(nick.trim());
}
