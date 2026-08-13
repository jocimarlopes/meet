import { Injectable } from '@angular/core';
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
 * Conexão WebRTC direta entre os dois navegadores.
 *
 * O host abre o DataChannel e manda a oferta; o convidado responde. Os SDP e
 * ICE candidates saem por `outboundSignals` para quem estiver orquestrando
 * mandar pelo servidor de signaling.
 */
@Injectable({ providedIn: 'root' })
export class PeerConnectionService {
  private connection: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  /** ICE que chega antes do remote description ficar pronto. */
  private queuedCandidates: RTCIceCandidateInit[] = [];

  private readonly state = new BehaviorSubject<PeerConnectionState>('idle');
  private readonly inbound = new Subject<string>();
  private readonly outbound = new Subject<SignalPayload>();

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

  /** SDP/ICE a serem repassados ao peer via signaling. */
  get outboundSignals(): Observable<SignalPayload> {
    return this.outbound.asObservable();
  }

  async start(role: 'host' | 'guest'): Promise<void> {
    this.close();
    this.state.next('connecting');

    const connection = new RTCPeerConnection({
      iceServers: environment.iceServers,
    });
    this.connection = connection;

    connection.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.outbound.next({ candidate: candidate.toJSON() });
      }
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
      this.attachChannel(connection.createDataChannel(CHANNEL_LABEL, { ordered: true }));
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      this.outbound.next({ description: connection.localDescription?.toJSON() });
    } else {
      connection.ondatachannel = ({ channel }) => this.attachChannel(channel);
    }
  }

  async acceptSignal(payload: SignalPayload): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      return;
    }

    if (payload.description) {
      await connection.setRemoteDescription(payload.description);
      await this.flushCandidates();

      if (payload.description.type === 'offer') {
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        this.outbound.next({ description: connection.localDescription?.toJSON() });
      }
      return;
    }

    if (payload.candidate) {
      if (connection.remoteDescription) {
        await connection.addIceCandidate(payload.candidate);
      } else {
        this.queuedCandidates.push(payload.candidate);
      }
    }
  }

  send(data: string): void {
    if (this.channel?.readyState !== 'open') {
      throw new Error('O canal com o peer não está aberto.');
    }
    this.channel.send(data);
  }

  close(): void {
    this.queuedCandidates = [];

    this.channel?.close();
    this.channel = null;

    const connection = this.connection;
    this.connection = null;
    if (connection) {
      connection.onicecandidate = null;
      connection.onconnectionstatechange = null;
      connection.ondatachannel = null;
      connection.close();
    }

    if (this.state.value !== 'idle') {
      this.state.next('idle');
    }
  }

  private attachChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.onopen = () => this.state.next('connected');
    channel.onclose = () => {
      if (this.state.value === 'connected') {
        this.state.next('disconnected');
      }
    };
    channel.onmessage = (event: MessageEvent<string>) => this.inbound.next(event.data);
  }

  private async flushCandidates(): Promise<void> {
    const pending = this.queuedCandidates;
    this.queuedCandidates = [];
    for (const candidate of pending) {
      await this.connection?.addIceCandidate(candidate).catch(() => undefined);
    }
  }
}
