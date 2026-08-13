import { Injectable, computed, inject, signal } from '@angular/core';

import {
  RoomView,
  ServerMessage,
  SignalPayload,
} from '../models/signaling.models';
import { Identity, PeerIdentity, PgpService } from './pgp.service';
import {
  PeerConnectionService,
  PeerConnectionState,
} from './peer-connection.service';
import { SignalingService } from './signaling.service';
import { SoundService } from './sound.service';

export type SessionStatus =
  | 'idle'
  | 'preparing'
  | 'waiting'
  | 'connecting'
  | 'connected'
  | 'ended';

export interface ChatMessage {
  id: string;
  kind: 'mine' | 'theirs' | 'system';
  nick: string;
  text: string;
  at: Date;
  /** Assinatura PGP conferida — só relevante em mensagens do peer. */
  verified: boolean;
}

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 1_500;

/**
 * Orquestra a sessão: gera as chaves, fala com o signaling até o WebRTC subir,
 * e daí em diante cifra/decifra tudo que passa pelo canal direto.
 *
 * Limite de confiança: o servidor de signaling é quem entrega a chave pública
 * do outro lado. Um servidor malicioso poderia entregar a chave dele e ficar no
 * meio. Por isso as duas pontas exibem a impressão digital — comparar por fora
 * (voz, outro app) é o que fecha esse buraco.
 */
@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly pgp = inject(PgpService);
  private readonly signaling = inject(SignalingService);
  private readonly peerConnection = inject(PeerConnectionService);
  private readonly sound = inject(SoundService);

  readonly status = signal<SessionStatus>('idle');
  readonly room = signal<RoomView | null>(null);
  readonly role = signal<'host' | 'guest' | null>(null);
  readonly messages = signal<ChatMessage[]>([]);
  readonly error = signal<string | null>(null);

  readonly myNick = signal<string | null>(null);
  readonly myFingerprint = signal<string | null>(null);
  readonly peerNick = signal<string | null>(null);
  readonly peerFingerprint = signal<string | null>(null);

  readonly isActive = computed(() => this.status() !== 'idle');
  readonly canSend = computed(() => this.status() === 'connected');

  /** Câmera e microfone, dos dois lados, cada um ligado de forma independente. */
  readonly localCamera = this.peerConnection.localCamera;
  readonly remoteCamera = this.peerConnection.remoteCamera;
  readonly remoteMic = this.peerConnection.remoteMic;
  readonly cameraOn = computed(() => this.localCamera() !== null);
  readonly micOn = computed(() => this.peerConnection.localMic() !== null);
  readonly anyVideo = computed(
    () => this.localCamera() !== null || this.remoteCamera() !== null,
  );

  private identity: Identity | null = null;
  private peer: PeerIdentity | null = null;
  private closingOnPurpose = false;
  private reconnectAttempts = 0;

  /**
   * Handlers assíncronos entram em fila para rodar em ordem. Sem isso, a
   * oferta SDP poderia ser processada antes de `room_joined` terminar de
   * montar a RTCPeerConnection (e seria descartada), e mensagens decifradas
   * poderiam aparecer fora de ordem.
   */
  private serverQueue: Promise<void> = Promise.resolve();
  private inboundQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.signaling.messages.subscribe((message) => {
      this.serverQueue = this.serverQueue
        .then(() => this.onServerMessage(message))
        .catch((cause: unknown) => this.onHandlerFailure(cause));
    });

    this.signaling.disconnections.subscribe(() => {
      void this.onSignalingDropped();
    });

    this.peerConnection.outboundSignals.subscribe((data) => {
      this.forwardSignal(data);
    });

    this.peerConnection.inboundData.subscribe((payload) => {
      this.inboundQueue = this.inboundQueue
        .then(() => this.onEncryptedPayload(payload))
        .catch((cause: unknown) => this.onHandlerFailure(cause));
    });

    this.peerConnection.state$.subscribe((state) => {
      this.onPeerConnectionState(state);
    });

    // Saber que o microfone do outro lado abriu importa: é a diferença entre
    // estar sendo ouvido ou não.
    this.peerConnection.remoteMediaChanges.subscribe(({ kind, active }) => {
      const who = this.peerNick() ?? 'A outra pessoa';
      if (kind === 'audio') {
        this.pushSystem(
          active ? `${who} abriu o microfone.` : `${who} desligou o microfone.`,
        );
      } else {
        this.pushSystem(
          active ? `${who} ligou a câmera.` : `${who} desligou a câmera.`,
        );
      }
    });
  }

  // -- ações do usuário ----------------------------------------------------

  async createRoom(nick: string): Promise<void> {
    await this.prepare(nick);
    this.role.set('host');
    await this.signaling.connect();
    this.signaling.send({
      type: 'create_room',
      name: `Sala de ${nick}`,
      nick,
      public_key: this.identity!.publicKeyArmored,
    });
  }

  async joinRoom(roomId: string, nick: string): Promise<void> {
    await this.prepare(nick);
    this.role.set('guest');
    await this.signaling.connect();
    this.signaling.send({
      type: 'join_room',
      room_id: roomId,
      nick,
      public_key: this.identity!.publicKeyArmored,
    });
  }

  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || !this.identity || !this.peer) {
      return;
    }

    const armored = await this.pgp.encryptFor(this.identity, this.peer, trimmed);
    this.peerConnection.send(armored);
    this.push({
      kind: 'mine',
      nick: this.identity.nick,
      text: trimmed,
      verified: true,
    });
  }

  /**
   * Liga ou desliga a própria câmera. Abrir a câmera no meio da conversa é uma
   * renegociação WebRTC, que trafega pelo canal direto — o servidor não volta
   * a participar.
   */
  async toggleCamera(): Promise<void> {
    if (this.cameraOn()) {
      this.peerConnection.stopMedia('video');
      this.pushSystem('Você desligou a câmera.');
      return;
    }
    await this.peerConnection.startMedia('video');
    this.pushSystem('Você ligou a câmera.');
  }

  /** Mesma mecânica da câmera, com o microfone. */
  async toggleMic(): Promise<void> {
    if (this.micOn()) {
      this.peerConnection.stopMedia('audio');
      this.pushSystem('Seu microfone está desligado.');
      return;
    }
    await this.peerConnection.startMedia('audio');
    this.pushSystem('Seu microfone está aberto — o outro lado ouve você.');
  }

  leave(): void {
    this.closingOnPurpose = true;
    if (this.signaling.isOpen) {
      this.signaling.send({ type: 'leave' });
    }
    this.signaling.disconnect();
    this.peerConnection.close();
    this.reset();
  }

  /** Impressão digital em blocos, para conferência por fora do app. */
  formatFingerprint(fingerprint: string | null): string {
    return fingerprint ? this.pgp.formatFingerprint(fingerprint) : '';
  }

  // -- signaling -----------------------------------------------------------

  private async onServerMessage(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case 'room_created':
        this.room.set(message.room);
        this.reconnectAttempts = 0;
        if (this.status() === 'preparing') {
          this.status.set('waiting');
        }
        break;

      case 'room_joined':
        this.room.set(message.room);
        this.reconnectAttempts = 0;
        if (message.peer) {
          await this.adoptPeer(message.peer.nick, message.peer.public_key);
          // O host é quem faz a oferta; aqui só preparamos para recebê-la.
          await this.peerConnection.start('guest');
          this.status.set('connecting');
        }
        break;

      case 'peer_joined':
        await this.adoptPeer(message.peer.nick, message.peer.public_key);
        this.sound.peerJoined();
        this.status.set('connecting');
        await this.peerConnection.start('host');
        break;

      case 'signal':
        await this.peerConnection.acceptSignal(message.data);
        break;

      case 'peer_left':
        // Assim que o P2P sobe, os dois lados fecham o signaling — mas não no
        // mesmo instante. Quem fecha primeiro gera um `peer_left` para o outro,
        // que ainda está ouvindo. Ignorar aqui evita derrubar uma conexão
        // direta que está funcionando; a saída real chega pela queda do
        // próprio DataChannel.
        if (this.status() === 'connected') {
          break;
        }
        this.peerConnection.close();
        this.peer = null;
        this.peerNick.set(null);
        this.peerFingerprint.set(null);
        this.pushSystem(`${message.nick} saiu da sala.`);
        this.status.set(this.role() === 'host' ? 'waiting' : 'ended');
        break;

      case 'error':
        this.error.set(message.message);
        this.closingOnPurpose = true;
        this.signaling.disconnect();
        this.peerConnection.close();
        this.reset();
        break;
    }
  }

  private forwardSignal(data: SignalPayload): void {
    if (!this.signaling.isOpen) {
      return;
    }
    this.signaling.send({ type: 'signal', data });
  }

  /**
   * A Vercel derruba o WebSocket ao bater o maxDuration. Se isso acontecer
   * antes do P2P subir, refaz o registro na mesma sala.
   */
  private async onSignalingDropped(): Promise<void> {
    if (this.closingOnPurpose) {
      return;
    }
    const status = this.status();
    if (status !== 'waiting' && status !== 'connecting' && status !== 'preparing') {
      return;
    }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.error.set('Conexão com o servidor de signaling perdida.');
      this.status.set('ended');
      return;
    }

    this.reconnectAttempts += 1;
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));

    const room = this.room();
    const identity = this.identity;
    if (!room || !identity) {
      return;
    }

    try {
      await this.signaling.connect();
      if (this.role() === 'host') {
        this.signaling.send({
          type: 'create_room',
          name: room.name,
          nick: identity.nick,
          public_key: identity.publicKeyArmored,
          room_id: room.id,
        });
      } else {
        this.signaling.send({
          type: 'join_room',
          room_id: room.id,
          nick: identity.nick,
          public_key: identity.publicKeyArmored,
        });
      }
    } catch {
      void this.onSignalingDropped();
    }
  }

  // -- WebRTC + PGP --------------------------------------------------------

  private onHandlerFailure(cause: unknown): void {
    console.error('falha ao processar evento da sessão', cause);
    this.pushSystem('Algo deu errado ao processar um evento da conexão.');
  }

  private onPeerConnectionState(state: PeerConnectionState): void {
    if (state === 'connected') {
      this.status.set('connected');
      this.pushSystem(
        'Canal direto aberto e cifrado. Compare a impressão digital com a outra pessoa antes de falar algo sensível.',
      );
      // O servidor não é mais necessário: daqui em diante é só P2P.
      this.closingOnPurpose = true;
      this.signaling.disconnect();
      return;
    }

    // Com o signaling já fechado, a saída do outro lado chega como queda do
    // canal direto — não como `peer_left`.
    if ((state === 'disconnected' || state === 'failed') && this.status() === 'connected') {
      const who = this.peerNick() ?? 'A outra pessoa';
      this.pushSystem(
        state === 'failed'
          ? 'A conexão direta falhou. Pode ser NAT restritivo — configure um servidor TURN.'
          : `${who} saiu ou perdeu a conexão.`,
      );
      this.status.set('ended');
    }
  }

  private async onEncryptedPayload(armored: string): Promise<void> {
    if (!this.identity || !this.peer) {
      return;
    }
    try {
      const { text, verified } = await this.pgp.decryptFrom(
        this.identity,
        this.peer,
        armored,
      );
      this.push({ kind: 'theirs', nick: this.peer.nick, text, verified });
      this.sound.messageReceived();
    } catch {
      this.pushSystem('Chegou uma mensagem que não foi possível decifrar.');
    }
  }

  private async adoptPeer(nick: string, armoredKey: string): Promise<void> {
    this.peer = await this.pgp.importPeerKey(nick, armoredKey);
    this.peerNick.set(this.peer.nick);
    this.peerFingerprint.set(this.peer.fingerprint);
  }

  // -- estado --------------------------------------------------------------

  private async prepare(nick: string): Promise<void> {
    this.leave();
    this.closingOnPurpose = false;
    this.error.set(null);
    this.status.set('preparing');

    this.identity = await this.pgp.generateIdentity(nick);
    this.myNick.set(this.identity.nick);
    this.myFingerprint.set(this.identity.fingerprint);
  }

  private reset(): void {
    this.identity = null;
    this.peer = null;
    this.reconnectAttempts = 0;
    this.status.set('idle');
    this.room.set(null);
    this.role.set(null);
    this.messages.set([]);
    this.myNick.set(null);
    this.myFingerprint.set(null);
    this.peerNick.set(null);
    this.peerFingerprint.set(null);
  }

  private push(message: Omit<ChatMessage, 'id' | 'at'>): void {
    this.messages.update((current) => [
      ...current,
      { ...message, id: crypto.randomUUID(), at: new Date() },
    ]);
  }

  private pushSystem(text: string): void {
    this.push({ kind: 'system', nick: 'sistema', text, verified: true });
  }
}
