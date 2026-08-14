import { Injectable, signal } from '@angular/core';

/** Acima disto (RMS de 0 a 1) considera-se que há voz. */
const SPEAKING_THRESHOLD = 0.02;
/** Silêncio precisa durar isto para apagar o indicador — evita piscar entre sílabas. */
const RELEASE_MS = 600;
const SAMPLE_INTERVAL_MS = 100;

interface Monitor {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buffer: Float32Array<ArrayBuffer>;
  timer: ReturnType<typeof setInterval>;
  quietSince: number | null;
}

/**
 * Detecta quem está falando medindo o nível do áudio de cada participante.
 *
 * O WebRTC não informa isso; a alternativa seria trocar mensagens de "estou
 * falando" pelo DataChannel, o que gastaria banda e ainda dependeria da boa-fé
 * do outro lado. Medir o próprio sinal é mais simples e sempre honesto.
 */
@Injectable({ providedIn: 'root' })
export class VoiceActivityService {
  /** Quem está falando agora, por identificador (apelido). */
  readonly speaking = signal<Record<string, boolean>>({});

  private context: AudioContext | null = null;
  private readonly monitors = new Map<string, Monitor>();

  watch(id: string, stream: MediaStream): void {
    if (this.monitors.has(id) || stream.getAudioTracks().length === 0) {
      return;
    }
    const context = this.ensureContext();
    if (!context) {
      return;
    }

    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    // Só analisamos: o áudio audível sai pelo elemento <audio> da tela. Ligar
    // aqui no destino duplicaria o som.
    source.connect(analyser);

    const monitor: Monitor = {
      source,
      analyser,
      buffer: new Float32Array(new ArrayBuffer(analyser.fftSize * 4)),
      quietSince: null,
      timer: setInterval(() => this.sample(id), SAMPLE_INTERVAL_MS),
    };
    this.monitors.set(id, monitor);
  }

  unwatch(id: string): void {
    const monitor = this.monitors.get(id);
    if (!monitor) {
      return;
    }
    clearInterval(monitor.timer);
    monitor.source.disconnect();
    monitor.analyser.disconnect();
    this.monitors.delete(id);
    this.setSpeaking(id, false);
  }

  /** Mantém só os ids informados, criando e removendo o que for preciso. */
  sync(streams: Record<string, MediaStream>): void {
    for (const id of [...this.monitors.keys()]) {
      if (!(id in streams)) {
        this.unwatch(id);
      }
    }
    for (const [id, stream] of Object.entries(streams)) {
      this.watch(id, stream);
    }
  }

  clear(): void {
    for (const id of [...this.monitors.keys()]) {
      this.unwatch(id);
    }
    this.speaking.set({});
  }

  private sample(id: string): void {
    const monitor = this.monitors.get(id);
    if (!monitor) {
      return;
    }

    monitor.analyser.getFloatTimeDomainData(monitor.buffer);
    let sum = 0;
    for (const value of monitor.buffer) {
      sum += value * value;
    }
    const rms = Math.sqrt(sum / monitor.buffer.length);

    if (rms >= SPEAKING_THRESHOLD) {
      monitor.quietSince = null;
      this.setSpeaking(id, true);
      return;
    }

    // Abaixo do limiar: só apaga depois de um tempo de silêncio contínuo.
    const now = Date.now();
    monitor.quietSince ??= now;
    if (now - monitor.quietSince >= RELEASE_MS) {
      this.setSpeaking(id, false);
    }
  }

  private setSpeaking(id: string, value: boolean): void {
    this.speaking.update((current) => {
      if ((current[id] ?? false) === value) {
        return current;
      }
      const next = { ...current };
      if (value) {
        next[id] = true;
      } else {
        delete next[id];
      }
      return next;
    });
  }

  private ensureContext(): AudioContext | null {
    if (this.context) {
      return this.context;
    }
    if (typeof AudioContext === 'undefined') {
      return null;
    }
    this.context = new AudioContext();
    return this.context;
  }
}
