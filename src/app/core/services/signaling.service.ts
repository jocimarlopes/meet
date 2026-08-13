import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

import { environment } from '../../../environments/environment';
import { ClientMessage, ServerMessage } from '../models/signaling.models';

const PING_INTERVAL_MS = 25_000;

/**
 * Canal com o servidor de apresentação.
 *
 * Fica aberto só até o DataChannel WebRTC subir; a partir daí a conversa é
 * direta entre os navegadores e este socket é fechado.
 */
@Injectable({ providedIn: 'root' })
export class SignalingService {
  private socket: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private readonly message$ = new Subject<ServerMessage>();
  private readonly disconnected$ = new Subject<void>();

  /** Mensagens do servidor (já parseadas). */
  get messages(): Observable<ServerMessage> {
    return this.message$.asObservable();
  }

  /** Emite quando o socket cai — inclusive pelo limite de duração da Vercel. */
  get disconnections(): Observable<void> {
    return this.disconnected$.asObservable();
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    if (this.isOpen) {
      return Promise.resolve();
    }
    this.disconnect();

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(environment.signalingUrl);
      this.socket = socket;

      socket.onopen = () => {
        this.startKeepAlive();
        resolve();
      };

      socket.onerror = () => {
        reject(new Error('Não foi possível falar com o servidor de signaling.'));
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        let parsed: ServerMessage;
        try {
          parsed = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        if (parsed.type !== 'pong') {
          this.message$.next(parsed);
        }
      };

      socket.onclose = () => {
        this.stopKeepAlive();
        if (this.socket === socket) {
          this.socket = null;
          this.disconnected$.next();
        }
      };
    });
  }

  send(message: ClientMessage): void {
    if (!this.isOpen) {
      throw new Error('Signaling desconectado.');
    }
    this.socket?.send(JSON.stringify(message));
  }

  disconnect(): void {
    this.stopKeepAlive();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= WebSocket.OPEN) {
      socket.onclose = null;
      socket.close();
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.pingTimer = setInterval(() => {
      if (this.isOpen) {
        this.socket?.send(JSON.stringify({ type: 'ping' }));
      }
    }, PING_INTERVAL_MS);
  }

  private stopKeepAlive(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
