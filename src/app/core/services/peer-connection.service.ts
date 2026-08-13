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

const CHANNEL_LABEL = 'chat';

/**
 * O DataChannel carrega dois tipos de tráfego: as mensagens do chat (já
 * cifradas com PGP) e o SDP/ICE das renegociações — abrir a câmera depois que
 * a conversa começou é uma renegociação.
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
 * cede em caso de colisão. Sem isso, os dois abrindo a câmera ao mesmo tempo
 * quebrariam a conexão.
 */
@Injectable({ providedIn: 'root' })
export class PeerConnectionService {
  private connection: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private cameraSender: RTCRtpSender | null = null;

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

  /** Câmera local, quando ligada. */
  readonly localStream = signal<MediaStream | null>(null);
  /** Câmera do outro lado, quando ele liga a dele. */
  readonly remoteStream = signal<MediaStream | null>(null);

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

  get cameraOn(): boolean {
    return this.localStream() !== null;
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
      this.remoteStream.set(stream);
      // removeTrack do outro lado chega aqui como mute, não como novo evento.
      track.onmute = () => this.remoteStream.set(null);
      track.onunmute = () => this.remoteStream.set(stream);
      track.onended = () => this.remoteStream.set(null);
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

  // -- câmera --------------------------------------------------------------

  /** Liga a câmera e renegocia. Sem áudio, de propósito. */
  async startCamera(): Promise<void> {
    const connection = this.connection;
    if (!connection || this.cameraSender) {
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });

    const [track] = stream.getVideoTracks();
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Nenhuma câmera disponível.');
    }

    // addTrack dispara negotiationneeded, que cuida da renegociação.
    this.cameraSender = connection.addTrack(track, stream);
    this.localStream.set(stream);
  }

  stopCamera(): void {
    const stream = this.localStream();
    this.localStream.set(null);
    stream?.getTracks().forEach((track) => track.stop());

    const sender = this.cameraSender;
    this.cameraSender = null;
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
    this.stopCamera();
    this.remoteStream.set(null);

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
