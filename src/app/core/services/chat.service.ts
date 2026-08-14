import { Injectable, computed, effect, inject, signal } from '@angular/core';

import {
  PeerView,
  RoomView,
  ServerMessage,
  Visibility,
  normalizeNick,
} from '../models/signaling.models';
import { MeshService } from './mesh.service';
import { MediaKind } from './peer-link';
import { Identity, PeerIdentity, PgpService } from './pgp.service';
import { SignalingService } from './signaling.service';
import { SoundService } from './sound.service';
import { VoiceActivityService } from './voice-activity.service';

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
  /** Assinatura PGP conferida — só relevante em mensagens de outros. */
  verified: boolean;
}

/** Um participante como a tela precisa vê-lo. */
export interface Participant {
  nick: string;
  fingerprint: string;
  connected: boolean;
}

/** Um quadro do palco: uma pessoa, com ou sem câmera. */
export interface Tile {
  nick: string;
  isSelf: boolean;
  /** Null quando a câmera está desligada — aí a tela mostra as iniciais. */
  camera: MediaStream | null;
  micOn: boolean;
  speaking: boolean;
  connected: boolean;
}

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 1_500;

/**
 * Orquestra a sessão: gera as chaves, fala com o signaling e mantém a malha de
 * conexões diretas, cifrando e decifrando tudo que passa por ela.
 *
 * Limite de confiança: o servidor é quem entrega as chaves públicas. Um
 * servidor malicioso poderia entregar a dele e ficar no meio. Por isso as
 * impressões digitais ficam visíveis — compará-las por fora é o que fecha esse
 * buraco.
 */
@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly pgp = inject(PgpService);
  private readonly signaling = inject(SignalingService);
  private readonly mesh = inject(MeshService);
  private readonly sound = inject(SoundService);
  private readonly voice = inject(VoiceActivityService);

  readonly status = signal<SessionStatus>('idle');
  readonly room = signal<RoomView | null>(null);
  readonly role = signal<'host' | 'guest' | null>(null);
  readonly messages = signal<ChatMessage[]>([]);
  readonly error = signal<string | null>(null);

  /**
   * Convite pelo qual se tentou entrar. Sobrevive ao erro de entrada para a
   * pessoa poder corrigir o apelido sem precisar do link de novo — o tombo
   * mais provável é justamente o apelido repetido.
   */
  readonly pendingInvite = signal<string | null>(null);

  readonly myNick = signal<string | null>(null);
  readonly myFingerprint = signal<string | null>(null);
  readonly participants = signal<Participant[]>([]);

  readonly isActive = computed(() => this.status() !== 'idle');

  /** Segundos até a sala vencer; recalculado a cada tique do relógio. */
  private readonly agora = signal(Date.now());
  readonly secondsLeft = computed(() => {
    const room = this.room();
    if (!room) {
      return null;
    }
    return Math.max(0, Math.round(room.expires_at * 1000 - this.agora()) / 1000);
  });

  /** Há quanto tempo a sala está aberta. Somado ao restante, dá o prazo total. */
  readonly elapsedSeconds = computed(() => {
    const room = this.room();
    if (!room) {
      return null;
    }
    return Math.max(0, Math.round((this.agora() - room.created_at * 1000) / 1000));
  });
  readonly connectedCount = computed(
    () => this.participants().filter((p) => p.connected).length,
  );
  readonly canSend = computed(() => this.connectedCount() > 0);

  /**
   * Câmera e microfone não dependem de ter gente conectada: ligar sozinho é
   * como conferir o enquadramento antes de chamar alguém. Quem entrar depois
   * recebe as tracks já na primeira oferta.
   */
  readonly canUseMedia = computed(() =>
    ['waiting', 'connecting', 'connected'].includes(this.status()),
  );

  /** Câmera e microfone: os seus e os dos outros, por nick. */
  readonly localCamera = this.mesh.localCamera;
  readonly remoteCameras = this.mesh.remoteCameras;
  readonly remoteMics = this.mesh.remoteMics;
  readonly cameraOn = computed(() => this.localCamera() !== null);
  readonly micOn = computed(() => this.mesh.localMic() !== null);
  readonly remoteCameraList = computed(() =>
    Object.entries(this.remoteCameras()).map(([nick, stream]) => ({ nick, stream })),
  );
  readonly remoteMicList = computed(() =>
    Object.entries(this.remoteMics()).map(([nick, stream]) => ({ nick, stream })),
  );
  readonly anyVideo = computed(
    () => this.localCamera() !== null || this.remoteCameraList().length > 0,
  );

  /**
   * O palco: você e todos os participantes, com câmera ou sem. Quem está sem
   * câmera continua ocupando um quadro — a sala precisa mostrar quem está lá.
   */
  readonly tiles = computed<Tile[]>(() => {
    const speaking = this.voice.speaking();
    const cameras = this.remoteCameras();
    const mics = this.remoteMics();
    const me = this.myNick();

    const self: Tile[] = me
      ? [
          {
            nick: me,
            isSelf: true,
            camera: this.localCamera(),
            micOn: this.micOn(),
            speaking: speaking[me] ?? false,
            connected: true,
          },
        ]
      : [];

    return [
      ...self,
      ...this.participants().map((peer) => ({
        nick: peer.nick,
        isSelf: false,
        camera: cameras[peer.nick] ?? null,
        micOn: peer.nick in mics,
        speaking: speaking[peer.nick] ?? false,
        connected: peer.connected,
      })),
    ];
  });

  private identity: Identity | null = null;
  private readonly peers = new Map<string, PeerIdentity>();
  private visibility: Visibility = 'private';
  private closingOnPurpose = false;
  private reconnectAttempts = 0;

  /**
   * Handlers assíncronos entram em fila para rodar em ordem. Sem isso, uma
   * oferta SDP poderia ser processada antes de a conexão estar montada, e
   * mensagens decifradas poderiam aparecer fora de ordem.
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

    this.mesh.signals.subscribe(({ to, payload }) => {
      if (this.signaling.isOpen) {
        this.signaling.send({ type: 'signal', to, data: payload });
      }
    });

    this.mesh.data.subscribe(({ from, payload }) => {
      this.inboundQueue = this.inboundQueue
        .then(() => this.onEncryptedPayload(from, payload))
        .catch((cause: unknown) => this.onHandlerFailure(cause));
    });

    this.mesh.linkStates.subscribe(({ nick, state }) => {
      this.onLinkState(nick, state);
    });

    this.mesh.remoteMediaAnnouncements.subscribe(({ nick, kind, active }) => {
      this.announceMedia(nick, kind, active);
    });

    // Relógio de baixa frequência, só para a tela mostrar o tempo restante.
    setInterval(() => {
      if (this.room()) {
        this.agora.set(Date.now());
      }
    }, 1000);

    // Mantém um medidor de nível por microfone aberto — o seu inclusive, para
    // você ver que está sendo captado.
    effect(() => {
      const streams: Record<string, MediaStream> = { ...this.remoteMics() };
      const me = this.myNick();
      const mine = this.mesh.localMic();
      if (me && mine) {
        streams[me] = mine;
      }
      this.voice.sync(streams);
    });
  }

  // -- ações do usuário ----------------------------------------------------

  async createRoom(nick: string, visibility: Visibility = 'private'): Promise<void> {
    await this.prepare(nick);
    this.visibility = visibility;
    this.role.set('host');
    await this.signaling.connect();
    this.signaling.send({
      type: 'create_room',
      name: `Sala de ${nick}`,
      nick,
      visibility,
      public_key: this.identity!.publicKeyArmored,
    });
  }

  async joinRoom(roomId: string, nick: string): Promise<void> {
    await this.prepare(nick);
    this.pendingInvite.set(roomId);
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
    const recipients = this.connectedPeers();
    if (!trimmed || !this.identity || recipients.length === 0) {
      return;
    }

    // Um bloco só, cifrado para todos: a sala inteira recebe bytes idênticos.
    const armored = await this.pgp.encryptFor(this.identity, recipients, trimmed);
    this.mesh.broadcast(armored);
    this.push({
      kind: 'mine',
      nick: this.identity.nick,
      text: trimmed,
      verified: true,
    });
  }

  async toggleCamera(): Promise<void> {
    await this.toggleMedia('video', 'câmera');
  }

  async toggleMic(): Promise<void> {
    if (this.micOn()) {
      this.mesh.stopMedia('audio');
      this.pushSystem('Seu microfone está desligado.');
      return;
    }
    await this.mesh.startMedia('audio');
    this.pushSystem(
      this.connectedCount() > 0
        ? 'Seu microfone está aberto — a sala ouve você.'
        : 'Seu microfone está aberto. Quem entrar já vai te ouvir.',
    );
  }

  leave(): void {
    // Saída deliberada: o convite deixa de valer.
    this.pendingInvite.set(null);
    this.closingOnPurpose = true;
    if (this.signaling.isOpen) {
      this.signaling.send({ type: 'leave' });
    }
    this.signaling.disconnect();
    this.mesh.closeAll();
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
        // Quem entra apenas responde às ofertas de quem já estava.
        for (const peer of message.peers) {
          await this.adoptPeer(peer, { offerer: false });
        }
        this.status.set(message.peers.length > 0 ? 'connecting' : 'waiting');
        break;

      case 'peer_joined':
        // Quem já estava é quem oferta ao recém-chegado.
        await this.adoptPeer(message.peer, { offerer: true });
        this.sound.peerJoined();
        this.pushSystem(`${message.peer.nick} entrou na sala.`);
        if (this.status() === 'waiting') {
          this.status.set('connecting');
        }
        break;

      case 'signal':
        await this.mesh.acceptSignal(message.from, message.data);
        break;

      case 'peer_left':
        // Com o canal direto de pé, a saída real chega pela queda dele. Este
        // aviso pode ser só a reconexão do signaling do outro lado.
        if (!this.mesh.isConnected(message.nick)) {
          this.dropPeer(message.nick, `${message.nick} saiu da sala.`);
        }
        break;

      case 'error':
        this.error.set(message.message);
        this.closingOnPurpose = true;
        this.signaling.disconnect();
        this.mesh.closeAll();
        this.reset();
        break;
    }
  }

  /**
   * A Vercel derruba o WebSocket ao bater o maxDuration. Ele precisa voltar:
   * é por ele que chegam os avisos de quem entra depois.
   */
  private async onSignalingDropped(): Promise<void> {
    if (this.closingOnPurpose || this.status() === 'idle') {
      return;
    }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.pushSystem(
        'Sem contato com o servidor: quem entrar agora não vai aparecer aqui.',
      );
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
          visibility: this.visibility,
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

  // -- malha ---------------------------------------------------------------

  private onLinkState(nick: string, state: string): void {
    this.refreshParticipants();

    if (state === 'connected') {
      this.status.set('connected');
      if (this.participants().length === 1) {
        this.pushSystem(
          'Canal direto aberto e cifrado. Compare as impressões digitais antes de falar algo sensível.',
        );
      }
      return;
    }

    if (state === 'closed' || state === 'failed') {
      this.dropPeer(
        nick,
        state === 'failed'
          ? `A conexão direta com ${nick} falhou. Pode ser NAT restritivo — configure um servidor TURN.`
          : `${nick} saiu da conversa.`,
      );
    }
  }

  private async onEncryptedPayload(from: string, armored: string): Promise<void> {
    const sender = this.peers.get(normalizeNick(from));
    if (!this.identity || !sender) {
      return;
    }
    try {
      const { text, verified } = await this.pgp.decryptFrom(
        this.identity,
        sender,
        armored,
      );
      this.push({ kind: 'theirs', nick: sender.nick, text, verified });
      this.sound.messageReceived();
    } catch {
      this.pushSystem(`Chegou de ${from} uma mensagem que não foi possível decifrar.`);
    }
  }

  private async adoptPeer(peer: PeerView, options: { offerer: boolean }): Promise<void> {
    const key = normalizeNick(peer.nick);
    // Reconexão do signaling reanuncia quem já está conectado; não refaz nada.
    if (this.mesh.has(peer.nick) && this.peers.has(key)) {
      return;
    }

    this.peers.set(key, await this.pgp.importPeerKey(peer.nick, peer.public_key));
    this.mesh.open(peer.nick, options.offerer);
    this.refreshParticipants();
  }

  private dropPeer(nick: string, notice: string): void {
    const key = normalizeNick(nick);
    if (!this.peers.has(key)) {
      return;
    }
    this.peers.delete(key);
    this.mesh.close(nick);
    this.pushSystem(notice);
    this.refreshParticipants();

    if (this.peers.size === 0) {
      this.status.set(this.role() === 'host' ? 'waiting' : 'ended');
    }
  }

  private refreshParticipants(): void {
    this.participants.set(
      [...this.peers.values()].map((peer) => ({
        nick: peer.nick,
        fingerprint: peer.fingerprint,
        connected: this.mesh.isConnected(peer.nick),
      })),
    );
  }

  private connectedPeers(): PeerIdentity[] {
    return [...this.peers.values()].filter((peer) => this.mesh.isConnected(peer.nick));
  }

  private announceMedia(nick: string, kind: MediaKind, active: boolean): void {
    if (kind === 'audio') {
      this.pushSystem(
        active ? `${nick} abriu o microfone.` : `${nick} desligou o microfone.`,
      );
    } else {
      this.pushSystem(active ? `${nick} ligou a câmera.` : `${nick} desligou a câmera.`);
    }
  }

  private async toggleMedia(kind: MediaKind, label: string): Promise<void> {
    if (this.mesh.isMediaOn(kind)) {
      this.mesh.stopMedia(kind);
      this.pushSystem(`Você desligou a ${label}.`);
      return;
    }
    await this.mesh.startMedia(kind);
    this.pushSystem(`Você ligou a ${label}.`);
  }

  private onHandlerFailure(cause: unknown): void {
    console.error('falha ao processar evento da sessão', cause);
    this.pushSystem('Algo deu errado ao processar um evento da conexão.');
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
    this.voice.clear();
    this.identity = null;
    this.peers.clear();
    this.reconnectAttempts = 0;
    this.status.set('idle');
    this.room.set(null);
    this.role.set(null);
    this.messages.set([]);
    this.myNick.set(null);
    this.myFingerprint.set(null);
    this.participants.set([]);
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
