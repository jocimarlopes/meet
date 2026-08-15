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
  | { kind: 'rtc'; payload: SignalPayload }
  // Uma imagem cifrada não cabe numa mensagem só do canal; vai fatiada e é
  // remontada do outro lado antes de virar `data`.
  | { kind: 'part'; id: string; seq: number; total: number; payload: string };

/**
 * Tamanho do pedaço. O SCTP fragmenta sozinho, mas mensagens grandes derrubam
 * a conexão em algumas combinações de navegador — 48 KB é o tamanho seguro que
 * todo mundo aceita.
 */
const CHUNK_SIZE = 48 * 1024;
/** Acima disto paramos de empurrar e esperamos o buffer drenar. */
const BUFFER_ALTO = 1024 * 1024;
const BUFFER_BAIXO = 256 * 1024;

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
  /** Pedaços esperando o canal drenar. */
  private readonly fila: ChannelEnvelope[] = [];
  private drenando = false;
  /** Pedaços recebidos, por remessa, até completar. */
  private readonly recebendo = new Map<string, { partes: string[]; faltam: number }>();

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

  /**
   * Mensagem pequena sai inteira, como sempre saiu. Grande — uma imagem — é
   * fatiada e enfileirada, para não estourar o limite do canal nem prender a
   * interface enquanto os pedaços saem.
   */
  send(payload: string): void {
    if (!this.isOpen) {
      return;
    }
    if (payload.length <= CHUNK_SIZE) {
      this.sendEnvelope({ kind: 'chat', payload });
      return;
    }

    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const total = Math.ceil(payload.length / CHUNK_SIZE);
    for (let seq = 0; seq < total; seq += 1) {
      this.fila.push({
        kind: 'part',
        id,
        seq,
        total,
        payload: payload.slice(seq * CHUNK_SIZE, (seq + 1) * CHUNK_SIZE),
      });
    }
    void this.drenar();
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
    this.fila.length = 0;
    this.recebendo.clear();
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

  /**
   * Esvazia a fila respeitando o buffer do canal. Sem isso, mandar uma imagem
   * de uma vez enche o buffer do SCTP e o navegador derruba a conexão.
   */
  private async drenar(): Promise<void> {
    if (this.drenando) {
      return;
    }
    this.drenando = true;
    try {
      while (this.fila.length > 0) {
        const canal = this.channel;
        if (!canal || canal.readyState !== 'open') {
          this.fila.length = 0;
          return;
        }
        if (canal.bufferedAmount > BUFFER_ALTO) {
          await this.esperarBuffer(canal);
          continue;
        }
        this.sendEnvelope(this.fila.shift()!);
      }
    } finally {
      this.drenando = false;
    }
  }

  private esperarBuffer(canal: RTCDataChannel): Promise<void> {
    return new Promise((resolve) => {
      canal.bufferedAmountLowThreshold = BUFFER_BAIXO;
      const pronto = () => {
        canal.removeEventListener('bufferedamountlow', pronto);
        resolve();
      };
      canal.addEventListener('bufferedamountlow', pronto);
    });
  }

  /** Junta os pedaços; só emite quando a remessa fecha. */
  private receberParte(envelope: Extract<ChannelEnvelope, { kind: 'part' }>): void {
    let remessa = this.recebendo.get(envelope.id);
    if (!remessa) {
      remessa = { partes: new Array(envelope.total).fill(''), faltam: envelope.total };
      this.recebendo.set(envelope.id, remessa);
    }
    if (remessa.partes[envelope.seq] === '') {
      remessa.partes[envelope.seq] = envelope.payload;
      remessa.faltam -= 1;
    }
    if (remessa.faltam === 0) {
      this.recebendo.delete(envelope.id);
      this.data.next(remessa.partes.join(''));
    }
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
      } else if (envelope.kind === 'part') {
        this.receberParte(envelope);
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
