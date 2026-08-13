import { Injectable, signal } from '@angular/core';

interface Note {
  frequency: number;
  /** Atraso em segundos a partir do início do toque. */
  at: number;
  duration: number;
  volume: number;
}

/** Duas notas subindo: alguém chegou. */
const PEER_JOINED: Note[] = [
  { frequency: 587.33, at: 0, duration: 0.12, volume: 0.18 },
  { frequency: 880.0, at: 0.11, duration: 0.16, volume: 0.18 },
];

/** Nota única e curta: mensagem recebida. */
const MESSAGE: Note[] = [{ frequency: 784.0, at: 0, duration: 0.11, volume: 0.14 }];

/**
 * Avisos sonoros sintetizados na hora.
 *
 * Sem arquivo de áudio de propósito: nada para baixar, funciona offline e não
 * abre exceção na política de conteúdo do app.
 */
@Injectable({ providedIn: 'root' })
export class SoundService {
  /** Preferência de sessão — como todo o resto, não sobrevive à aba. */
  readonly muted = signal(false);

  private context: AudioContext | null = null;

  /**
   * Precisa ser chamado de dentro de um gesto do usuário (o clique em criar
   * ou entrar na sala). Navegadores bloqueiam áudio iniciado sem interação, e
   * o primeiro evento sonoro acontece bem depois desse clique.
   */
  unlock(): void {
    const context = this.ensureContext();
    if (context?.state === 'suspended') {
      void context.resume();
    }
  }

  toggleMute(): void {
    this.muted.update((muted) => !muted);
  }

  peerJoined(): void {
    this.play(PEER_JOINED);
  }

  messageReceived(): void {
    this.play(MESSAGE);
  }

  private play(notes: Note[]): void {
    if (this.muted()) {
      return;
    }
    const context = this.ensureContext();
    if (!context) {
      return;
    }
    if (context.state === 'suspended') {
      void context.resume();
    }

    const now = context.currentTime;
    for (const note of notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.value = note.frequency;

      // Envelope curto nas duas pontas: sem ele o tom estala.
      const start = now + note.at;
      const end = start + note.duration;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(note.volume, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);

      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(end + 0.02);
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.context) {
      return this.context;
    }
    // Navegador sem Web Audio: o chat segue funcionando, só sem aviso sonoro.
    if (typeof AudioContext === 'undefined') {
      return null;
    }
    this.context = new AudioContext();
    return this.context;
  }
}
