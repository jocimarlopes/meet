import { Injectable, signal } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';

import { environment } from '../../../environments/environment';
import { SignalPayload } from '../models/signaling.models';

export type PeerConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed';

/** Câmera e microfone são ligados e desligados de forma independente. */
export type MediaKind = 'video' | 'audio';

export interface RemoteMediaChange {
  kind: MediaKind;
  active: boolean;
}

const CHANNEL_LABEL = 'chat';

const CONSTRAINTS: Record<MediaKind, MediaStreamConstraints> = {
  video: {
    video: { width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  },
  audio: {
    // O cancelamento de eco do navegador evita realimentação em alto-falante.
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  },
};

/**
 * O DataChannel carrega dois tipos de tráfego: as mensagens do chat (já
 * cifradas com PGP) e o SDP/ICE das renegociações — abrir câmera ou microfone
 * depois que a conversa começou é uma renegociação.
 *
 * Mandar isso pelo próprio canal direto, e não de volta pelo servidor, mantém
 * a promessa do desenho: depois do pareamento o backend sai de cena e não
 * volta.
 */
type ChannelEnvelope =
  | { kind: 'chat'; payload: string }
  | { kind: 'rtc'; payload: SignalPayload };

/**
 * Conexão WebRTC direta entre os dois navegadores.
 *
 * A negociação segue o padrão *perfect negotiation*: um lado é "educado" e
 * cede em caso de colisão. Sem isso, os dois ligando a câmera ao mesmo tempo
 * quebrariam a conexão.
 */
@Injectable({ providedIn: 'root' })
export class PeerConnectionService {
  private connection: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;

  private readonly senders = new Map<MediaKind, RTCRtpSender>();

  /** ICE que chega antes do remote description ficar pronto. */
  private queuedCandidates: RTCIceCandidateInit[] = [];

  // Estado do perfect negotiation.
  private polite = false;
  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswer = false;

  private readonly state = new BehaviorSubject<PeerConnectionState>('idle');
  private readonly inbound = new Subject<string>();
  private readonly outbound = new Subject<SignalPayload>();
  private readonly remoteMedia = new Subject<RemoteMediaChange>();

  /** Mídia local. O microfone não é reproduzido aqui — ninguém quer se ouvir. */
  readonly localCamera = signal<MediaStream | null>(null);
  readonly localMic = signal<MediaStream | null>(null);

  /** Mídia do outro lado, cada uma ligada por ele de forma independente. */
  readonly remoteCamera = signal<MediaStream | null>(null);
  readonly remoteMic = signal<MediaStream | null>(null);

  get state$(): Observable<PeerConnectionState> {
    return this.state.asObservable();
  }

  get currentState(): PeerConnectionState {
    return this.state.value;
  }

  /** Payloads cifrados recebidos do peer. */
  get inboundData(): Observable<string> {
    return this.inbound.asObservable();
  }

  /**
   * SDP/ICE que precisa ir pelo servidor de signaling — só acontece antes do
   * canal direto existir. Depois disso a renegociação vai por dentro dele.
   */
  get outboundSignals(): Observable<SignalPayload> {
    return this.outbound.asObservable();
  }

  /** O outro lado ligou ou desligou câmera/microfone. */
  get remoteMediaChanges(): Observable<RemoteMediaChange> {
    return this.remoteMedia.asObservable();
  }

  async start(role: 'host' | 'guest'): Promise<void> {
    this.close();
    this.state.next('connecting');
    // O anfitrião é o "grosseiro": em colisão, a oferta dele prevalece.
    this.polite = role === 'guest';

    const connection = new RTCPeerConnection({
      iceServers: environment.iceServers,
    });
    this.connection = connection;

    connection.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.emitSignal({ candidate: candidate.toJSON() });
      }
    };

    connection.onnegotiationneeded = async () => {
      if (connection !== this.connection) {
        return;
      }
      try {
        this.makingOffer = true;
        await connection.setLocalDescription();
        const description = connection.localDescription;
        if (description) {
          this.emitSignal({ description: description.toJSON() });
        }
      } catch {
        // Negociação falha aqui é recuperável: o outro lado ainda pode ofertar.
      } finally {
        this.makingOffer = false;
      }
    };

    connection.ontrack = ({ streams, track }) => {
      const stream = streams[0] ?? new MediaStream([track]);
      const kind: MediaKind = track.kind === 'audio' ? 'audio' : 'video';

      this.setRemote(kind, stream);
      // removeTrack do outro lado chega aqui como mute, não como novo evento.
      track.onmute = () => this.setRemote(kind, null);
      track.onunmute = () => this.setRemote(kind, stream);
      track.onended = () => this.setRemote(kind, null);
    };

    connection.onconnectionstatechange = () => {
      if (connection !== this.connection) {
        return;
      }
      if (connection.connectionState === 'failed') {
        this.state.next('failed');
      } else if (
        connection.connectionState === 'disconnected' ||
        connection.connectionState === 'closed'
      ) {
        this.state.next('disconnected');
      }
    };

    if (role === 'host') {
      // Criar o canal já dispara negotiationneeded, que manda a oferta.
      this.attachChannel(connection.createDataChannel(CHANNEL_LABEL, { ordered: true }));
    } else {
      connection.ondatachannel = ({ channel }) => this.attachChannel(channel);
    }
  }

  /** Trata SDP/ICE venha de onde vier: do signaling ou do próprio canal. */
  async acceptSignal(payload: SignalPayload): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      return;
    }

    if (payload.description) {
      const description = payload.description;
      const readyForOffer =
        !this.makingOffer &&
        (connection.signalingState === 'stable' || this.settingRemoteAnswer);
      const collision = description.type === 'offer' && !readyForOffer;

      // Em colisão, quem é educado desfaz a própria oferta; o outro ignora.
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) {
        return;
      }

      this.settingRemoteAnswer = description.type === 'answer';
      await connection.setRemoteDescription(description);
      this.settingRemoteAnswer = false;
      await this.flushCandidates();

      if (description.type === 'offer') {
        await connection.setLocalDescription();
        const answer = connection.localDescription;
        if (answer) {
          this.emitSignal({ description: answer.toJSON() });
        }
      }
      return;
    }

    if (payload.candidate) {
      if (!connection.remoteDescription) {
        this.queuedCandidates.push(payload.candidate);
        return;
      }
      try {
        await connection.addIceCandidate(payload.candidate);
      } catch (cause) {
        // Candidato órfão de uma oferta ignorada não é erro real.
        if (!this.ignoreOffer) {
          throw cause;
        }
      }
    }
  }

  // -- câmera e microfone --------------------------------------------------

  /** Liga a mídia local e renegocia. Vídeo nunca leva áudio junto. */
  async startMedia(kind: MediaKind): Promise<void> {
    const connection = this.connection;
    if (!connection || this.senders.has(kind)) {
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS[kind]);
    const [track] = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
    if (!track) {
      stream.getTracks().forEach((each) => each.stop());
      throw new Error(
        kind === 'audio' ? 'Nenhum microfone disponível.' : 'Nenhuma câmera disponível.',
      );
    }

    // addTrack dispara negotiationneeded, que cuida da renegociação.
    this.senders.set(kind, connection.addTrack(track, stream));
    this.localSignal(kind).set(stream);
  }

  stopMedia(kind: MediaKind): void {
    const local = this.localSignal(kind);
    const stream = local();
    local.set(null);
    stream?.getTracks().forEach((track) => track.stop());

    const sender = this.senders.get(kind);
    this.senders.delete(kind);
    if (sender && this.connection) {
      try {
        this.connection.removeTrack(sender);
      } catch {
        // Conexão já fechada: nada a renegociar.
      }
    }
  }

  // -- envio ---------------------------------------------------------------

  send(data: string): void {
    this.sendEnvelope({ kind: 'chat', payload: data });
  }

  close(): void {
    this.stopMedia('video');
    this.stopMedia('audio');
    this.remoteCamera.set(null);
    this.remoteMic.set(null);

    this.queuedCandidates = [];
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.settingRemoteAnswer = false;

    this.channel?.close();
    this.channel = null;

    const connection = this.connection;
    this.connection = null;
    if (connection) {
      connection.onicecandidate = null;
      connection.onconnectionstatechange = null;
      connection.onnegotiationneeded = null;
      connection.ondatachannel = null;
      connection.ontrack = null;
      connection.close();
    }

    if (this.state.value !== 'idle') {
      this.state.next('idle');
    }
  }

  // -- internos ------------------------------------------------------------

  private localSignal(kind: MediaKind) {
    return kind === 'audio' ? this.localMic : this.localCamera;
  }

  private remoteSignal(kind: MediaKind) {
    return kind === 'audio' ? this.remoteMic : this.remoteCamera;
  }

  private setRemote(kind: MediaKind, stream: MediaStream | null): void {
    const target = this.remoteSignal(kind);
    const wasActive = target() !== null;
    target.set(stream);
    // `onmute` pode disparar repetido; só avisa quando o estado muda de fato.
    if (wasActive !== (stream !== null)) {
      this.remoteMedia.next({ kind, active: stream !== null });
    }
  }

  /**
   * Enquanto o canal direto não existe, SDP e ICE saem pelo servidor. Depois
   * que ele abre, vão por dentro dele.
   */
  private emitSignal(payload: SignalPayload): void {
    if (this.channel?.readyState === 'open') {
      this.sendEnvelope({ kind: 'rtc', payload });
      return;
    }
    this.outbound.next(payload);
  }

  private sendEnvelope(envelope: ChannelEnvelope): void {
    if (this.channel?.readyState !== 'open') {
      throw new Error('O canal com o peer não está aberto.');
    }
    this.channel.send(JSON.stringify(envelope));
  }

  private attachChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.onopen = () => this.state.next('connected');
    channel.onclose = () => {
      if (this.state.value === 'connected') {
        this.state.next('disconnected');
      }
    };
    channel.onmessage = (event: MessageEvent<string>) => {
      let envelope: ChannelEnvelope;
      try {
        envelope = JSON.parse(event.data) as ChannelEnvelope;
      } catch {
        return;
      }
      if (envelope.kind === 'chat') {
        this.inbound.next(envelope.payload);
      } else if (envelope.kind === 'rtc') {
        void this.acceptSignal(envelope.payload);
      }
    };
  }

  private async flushCandidates(): Promise<void> {
    const pending = this.queuedCandidates;
    this.queuedCandidates = [];
    for (const candidate of pending) {
      await this.connection?.addIceCandidate(candidate).catch(() => undefined);
    }
  }
}
