import { Subject } from 'rxjs';

import { SignalPayload } from '../models/signaling.models';

export type LinkState = 'connecting' | 'connected' | 'closed' | 'failed';

/** Câmera e microfone são ligados e desligados de forma independente. */
export type MediaKind = 'video' | 'audio';

export interface RemoteMediaEvent {
  kind: MediaKind;
  stream: MediaStream | null;
}

/**
 * O DataChannel carrega dois tipos de tráfego: as mensagens do chat (já
 * cifradas com PGP) e o SDP/ICE das renegociações — abrir câmera ou microfone
 * depois que a conversa começou é uma renegociação.
 *
 * Mandar isso pelo próprio canal direto, e não de volta pelo servidor, mantém
 * a promessa do desenho: depois do pareamento o backend sai de cena.
 */
type ChannelEnvelope =
  | { kind: 'chat'; payload: string }
  | { kind: 'rtc'; payload: SignalPayload };

const CHANNEL_LABEL = 'chat';
/**
 * Janela de agrupamento dos candidatos ICE. Eles chegam em rajada logo após a
 * oferta, e mandar um por mensagem fazia deles a maior fatia do tráfego de
 * signaling. Curta o bastante para não atrasar o handshake de forma perceptível.
 */
const CANDIDATE_BATCH_MS = 200;

/**
 * Uma conexão WebRTC com **um** participante.
 *
 * Numa sala de N pessoas cada uma mantém N-1 destas. A negociação segue o
 * padrão *perfect negotiation*: quem oferta é o "grosseiro" e prevalece em
 * caso de colisão, o outro cede. Sem isso, dois lados ligando a câmera ao
 * mesmo tempo quebrariam a conexão.
 */
export class PeerLink {
  readonly signals = new Subject<SignalPayload>();
  readonly data = new Subject<string>();
  readonly states = new Subject<LinkState>();
  readonly remoteMedia = new Subject<RemoteMediaEvent>();

  state: LinkState = 'connecting';

  private readonly connection: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private readonly senders = new Map<MediaKind, RTCRtpSender>();
  private readonly remoteStreams = new Map<MediaKind, MediaStream>();
  private queuedCandidates: RTCIceCandidateInit[] = [];
  /** Candidatos locais esperando para sair em lote. */
  private outgoingCandidates: RTCIceCandidateInit[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly polite: boolean;
  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswer = false;

  constructor(
    readonly nick: string,
    offerer: boolean,
    iceServers: RTCIceServer[],
  ) {
    // Quem oferta é o grosseiro; quem responde cede em colisão.
    this.polite = !offerer;
    this.connection = new RTCPeerConnection({ iceServers });

    this.connection.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.queueOutgoingCandidate(candidate.toJSON());
      }
    };

    this.connection.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.connection.setLocalDescription();
        const description = this.connection.localDescription;
        if (description) {
          this.emitSignal({ description: description.toJSON() });
        }
      } catch {
        // Recuperável: o outro lado ainda pode ofertar.
      } finally {
        this.makingOffer = false;
      }
    };

    this.connection.ontrack = ({ streams, track }) => {
      const stream = streams[0] ?? new MediaStream([track]);
      const kind: MediaKind = track.kind === 'audio' ? 'audio' : 'video';

      this.setRemote(kind, stream);
      // removeTrack do outro lado chega como mute, não como novo evento.
      track.onmute = () => this.setRemote(kind, null);
      track.onunmute = () => this.setRemote(kind, stream);
      track.onended = () => this.setRemote(kind, null);
    };

    this.connection.onconnectionstatechange = () => {
      const current = this.connection.connectionState;
      if (current === 'failed') {
        this.setState('failed');
      } else if (current === 'disconnected' || current === 'closed') {
        this.setState('closed');
      }
    };

    if (offerer) {
      // Criar o canal já dispara negotiationneeded, que manda a oferta.
      this.attachChannel(
        this.connection.createDataChannel(CHANNEL_LABEL, { ordered: true }),
      );
    } else {
      this.connection.ondatachannel = ({ channel }) => this.attachChannel(channel);
    }
  }

  get isOpen(): boolean {
    return this.channel?.readyState === 'open';
  }

  async acceptSignal(payload: SignalPayload): Promise<void> {
    if (payload.description) {
      const description = payload.description;
      const readyForOffer =
        !this.makingOffer &&
        (this.connection.signalingState === 'stable' || this.settingRemoteAnswer);
      const collision = description.type === 'offer' && !readyForOffer;

      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) {
        return;
      }

      this.settingRemoteAnswer = description.type === 'answer';
      await this.connection.setRemoteDescription(description);
      this.settingRemoteAnswer = false;
      await this.flushCandidates();

      if (description.type === 'offer') {
        await this.connection.setLocalDescription();
        const answer = this.connection.localDescription;
        if (answer) {
          this.emitSignal({ description: answer.toJSON() });
        }
      }
      return;
    }

    for (const candidate of payload.candidates ?? []) {
      if (!this.connection.remoteDescription) {
        this.queuedCandidates.push(candidate);
        continue;
      }
      try {
        await this.connection.addIceCandidate(candidate);
      } catch (cause) {
        if (!this.ignoreOffer) {
          throw cause;
        }
      }
    }
  }

  private queueOutgoingCandidate(candidate: RTCIceCandidateInit): void {
    this.outgoingCandidates.push(candidate);
    this.batchTimer ??= setTimeout(() => this.flushOutgoing(), CANDIDATE_BATCH_MS);
  }

  private flushOutgoing(): void {
    this.batchTimer = null;
    const lote = this.outgoingCandidates;
    this.outgoingCandidates = [];
    if (lote.length > 0) {
      this.emitSignal({ candidates: lote });
    }
  }

  send(payload: string): void {
    if (!this.isOpen) {
      return;
    }
    this.sendEnvelope({ kind: 'chat', payload });
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream): void {
    const kind: MediaKind = track.kind === 'audio' ? 'audio' : 'video';
    if (this.senders.has(kind)) {
      return;
    }
    this.senders.set(kind, this.connection.addTrack(track, stream));
  }

  removeTrack(kind: MediaKind): void {
    const sender = this.senders.get(kind);
    this.senders.delete(kind);
    if (!sender) {
      return;
    }
    try {
      this.connection.removeTrack(sender);
    } catch {
      // Conexão já fechada: nada a renegociar.
    }
  }

  close(): void {
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.outgoingCandidates = [];
    this.queuedCandidates = [];
    this.senders.clear();
    this.remoteStreams.clear();

    this.channel?.close();
    this.channel = null;

    this.connection.onicecandidate = null;
    this.connection.onnegotiationneeded = null;
    this.connection.onconnectionstatechange = null;
    this.connection.ondatachannel = null;
    this.connection.ontrack = null;
    this.connection.close();

    this.setState('closed');
    this.signals.complete();
    this.data.complete();
    this.states.complete();
    this.remoteMedia.complete();
  }

  // -- internos ------------------------------------------------------------

  private setState(state: LinkState): void {
    if (this.state === state || this.state === 'closed') {
      return;
    }
    this.state = state;
    this.states.next(state);
  }

  private setRemote(kind: MediaKind, stream: MediaStream | null): void {
    const had = this.remoteStreams.has(kind);
    if (stream) {
      this.remoteStreams.set(kind, stream);
    } else {
      this.remoteStreams.delete(kind);
    }
    // `onmute` pode disparar repetido; só avisa quando o estado muda de fato.
    if (had !== (stream !== null)) {
      this.remoteMedia.next({ kind, stream });
    }
  }

  /**
   * Enquanto o canal direto não abre, SDP e ICE saem pelo servidor. Depois,
   * vão por dentro dele.
   */
  private emitSignal(payload: SignalPayload): void {
    if (this.isOpen) {
      this.sendEnvelope({ kind: 'rtc', payload });
      return;
    }
    this.signals.next(payload);
  }

  private sendEnvelope(envelope: ChannelEnvelope): void {
    this.channel?.send(JSON.stringify(envelope));
  }

  private attachChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.onopen = () => this.setState('connected');
    channel.onclose = () => this.setState('closed');
    channel.onmessage = (event: MessageEvent<string>) => {
      let envelope: ChannelEnvelope;
      try {
        envelope = JSON.parse(event.data) as ChannelEnvelope;
      } catch {
        return;
      }
      if (envelope.kind === 'chat') {
        this.data.next(envelope.payload);
      } else if (envelope.kind === 'rtc') {
        void this.acceptSignal(envelope.payload);
      }
    };
  }

  private async flushCandidates(): Promise<void> {
    const pending = this.queuedCandidates;
    this.queuedCandidates = [];
    for (const candidate of pending) {
      await this.connection.addIceCandidate(candidate).catch(() => undefined);
    }
  }
}
