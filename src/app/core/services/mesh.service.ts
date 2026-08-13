import { Injectable, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';

import { environment } from '../../../environments/environment';
import { SignalPayload, normalizeNick } from '../models/signaling.models';
import { LinkState, MediaKind, PeerLink } from './peer-link';

export interface MeshData {
  from: string;
  payload: string;
}

export interface MeshSignal {
  to: string;
  payload: SignalPayload;
}

export interface MeshLinkState {
  nick: string;
  state: LinkState;
}

export interface MeshMediaAnnouncement {
  nick: string;
  kind: MediaKind;
  active: boolean;
}

/** Streams remotos indexados pelo nick de quem os envia. */
export type StreamsByNick = Record<string, MediaStream>;

const CONSTRAINTS: Record<MediaKind, MediaStreamConstraints> = {
  video: {
    video: { width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  },
  audio: {
    // O cancelamento de eco do navegador evita realimentação em alto-falante.
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  },
};

/**
 * A malha de conexões: uma `PeerLink` por participante.
 *
 * Numa sala de N pessoas, cada uma mantém N-1 conexões. A mídia local é
 * capturada uma vez e a mesma track é enviada por todas as conexões — inclusive
 * as que forem abertas depois, quando alguém entra com a câmera já ligada.
 */
@Injectable({ providedIn: 'root' })
export class MeshService {
  private readonly links = new Map<string, PeerLink>();
  private readonly localStreams = new Map<MediaKind, MediaStream>();

  private readonly data$ = new Subject<MeshData>();
  private readonly signals$ = new Subject<MeshSignal>();
  private readonly linkStates$ = new Subject<MeshLinkState>();
  private readonly mediaAnnouncements$ = new Subject<MeshMediaAnnouncement>();

  /** Câmera e microfone locais. O microfone não é reproduzido: ninguém quer se ouvir. */
  readonly localCamera = signal<MediaStream | null>(null);
  readonly localMic = signal<MediaStream | null>(null);

  /** Mídia dos outros, por nick. */
  readonly remoteCameras = signal<StreamsByNick>({});
  readonly remoteMics = signal<StreamsByNick>({});

  /** Quem já tem canal direto aberto. */
  readonly connected = signal<string[]>([]);

  get data(): Observable<MeshData> {
    return this.data$.asObservable();
  }

  /** SDP/ICE que precisa ir pelo servidor — só antes do canal direto abrir. */
  get signals(): Observable<MeshSignal> {
    return this.signals$.asObservable();
  }

  get linkStates(): Observable<MeshLinkState> {
    return this.linkStates$.asObservable();
  }

  /** Alguém ligou ou desligou câmera/microfone. */
  get remoteMediaAnnouncements(): Observable<MeshMediaAnnouncement> {
    return this.mediaAnnouncements$.asObservable();
  }

  has(nick: string): boolean {
    return this.links.has(normalizeNick(nick));
  }

  isConnected(nick: string): boolean {
    return this.links.get(normalizeNick(nick))?.state === 'connected';
  }

  get size(): number {
    return this.links.size;
  }

  /**
   * Abre a conexão com um participante. Quem já estava na sala oferta ao
   * recém-chegado; o recém-chegado apenas responde. Essa regra fixa evita que
   * os dois lados ofertem ao mesmo tempo.
   */
  open(nick: string, offerer: boolean): PeerLink {
    const key = normalizeNick(nick);
    const existing = this.links.get(key);
    if (existing) {
      return existing;
    }

    const link = new PeerLink(nick, offerer, environment.iceServers);
    this.links.set(key, link);

    link.signals.subscribe((payload) => this.signals$.next({ to: nick, payload }));
    link.data.subscribe((payload) => this.data$.next({ from: nick, payload }));

    link.states.subscribe((state) => {
      this.refreshConnected();
      this.linkStates$.next({ nick, state });
      if (state === 'closed' || state === 'failed') {
        this.forget(nick);
      }
    });

    link.remoteMedia.subscribe(({ kind, stream }) => {
      const target = kind === 'audio' ? this.remoteMics : this.remoteCameras;
      target.update((current) => {
        const next = { ...current };
        if (stream) {
          next[nick] = stream;
        } else {
          delete next[nick];
        }
        return next;
      });
      this.mediaAnnouncements$.next({ nick, kind, active: stream !== null });
    });

    // Quem entra depois da câmera ligada já recebe a track na primeira oferta.
    for (const [kind, stream] of this.localStreams) {
      const [track] = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
      if (track) {
        link.addTrack(track, stream);
      }
    }

    return link;
  }

  async acceptSignal(from: string, payload: SignalPayload): Promise<void> {
    // Uma oferta de quem ainda não conhecemos abre a conexão como respondedor.
    const link = this.links.get(normalizeNick(from)) ?? this.open(from, false);
    await link.acceptSignal(payload);
  }

  /** Envia o mesmo bloco cifrado para todos — o PGP já é multidestinatário. */
  broadcast(payload: string): void {
    for (const link of this.links.values()) {
      link.send(payload);
    }
  }

  close(nick: string): void {
    const key = normalizeNick(nick);
    const link = this.links.get(key);
    if (!link) {
      return;
    }
    this.links.delete(key);
    link.close();
    this.dropRemote(nick);
    this.refreshConnected();
  }

  closeAll(): void {
    this.stopMedia('video');
    this.stopMedia('audio');
    for (const link of this.links.values()) {
      link.close();
    }
    this.links.clear();
    this.remoteCameras.set({});
    this.remoteMics.set({});
    this.connected.set([]);
  }

  // -- mídia ---------------------------------------------------------------

  async startMedia(kind: MediaKind): Promise<void> {
    if (this.localStreams.has(kind)) {
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

    this.localStreams.set(kind, stream);
    this.localSignal(kind).set(stream);
    // Uma captura só, distribuída por todas as conexões.
    for (const link of this.links.values()) {
      link.addTrack(track, stream);
    }
  }

  stopMedia(kind: MediaKind): void {
    const stream = this.localStreams.get(kind);
    this.localStreams.delete(kind);
    this.localSignal(kind).set(null);
    stream?.getTracks().forEach((track) => track.stop());

    for (const link of this.links.values()) {
      link.removeTrack(kind);
    }
  }

  isMediaOn(kind: MediaKind): boolean {
    return this.localStreams.has(kind);
  }

  // -- internos ------------------------------------------------------------

  private localSignal(kind: MediaKind) {
    return kind === 'audio' ? this.localMic : this.localCamera;
  }

  private forget(nick: string): void {
    const key = normalizeNick(nick);
    if (this.links.get(key)?.state === 'connected') {
      return;
    }
    this.links.delete(key);
    this.dropRemote(nick);
    this.refreshConnected();
  }

  private dropRemote(nick: string): void {
    for (const target of [this.remoteCameras, this.remoteMics]) {
      target.update((current) => {
        if (!(nick in current)) {
          return current;
        }
        const next = { ...current };
        delete next[nick];
        return next;
      });
    }
  }

  private refreshConnected(): void {
    const open = [...this.links.values()]
      .filter((link) => link.state === 'connected')
      .map((link) => link.nick);
    this.connected.set(open);
  }
}
