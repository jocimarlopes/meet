import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';

/** Um trecho reconhecido. `final` marca o que o motor não vai mais corrigir. */
export interface CaptionChunk {
  text: string;
  final: boolean;
}

export type CaptionSupport = 'no-device' | 'downloadable' | 'ready' | 'unsupported';

/**
 * O reconhecimento é de **um** idioma por vez — a API não aceita lista, e o
 * modelo local é um pacote por língua. Frase misturada sai errada, e isso não
 * tem conserto do nosso lado: o motor vai forçar o que ouviu na fonética da
 * língua escolhida.
 *
 * Então tentamos o idioma do aparelho e caímos no português quando ele não
 * estiver disponível localmente.
 */
const PADRAO = 'pt-BR';

/**
 * Legenda do que **você** fala, reconhecida no próprio aparelho.
 *
 * O desenho tem uma regra que não é negociável neste projeto: `processLocally`
 * sempre ligado. O modo padrão da API manda o áudio para um serviço do
 * fabricante do navegador — num app que promete que nada sai daqui, seria uma
 * contradição servida de bandeja. Sem reconhecimento local, a legenda
 * simplesmente não é oferecida.
 *
 * Cada pessoa transcreve o próprio microfone e manda o texto cifrado pelo
 * canal direto. Transcrever o áudio dos outros custaria uma vez por
 * participante e ainda não diria quem falou.
 */
@Injectable({ providedIn: 'root' })
export class CaptionService {
  readonly chunks = new Subject<CaptionChunk>();
  /** Baixando o pacote de idioma: a tela avisa em vez de parecer travada. */
  readonly installing = signal(false);

  private recognition: SpeechRecognition | null = null;
  private querendoOuvir = false;
  private idiomaEscolhido: string | null = null;

  private get Motor(): typeof SpeechRecognition | null {
    return (
      (window as unknown as { SpeechRecognition?: typeof SpeechRecognition })
        .SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: typeof SpeechRecognition })
        .webkitSpeechRecognition ??
      null
    );
  }

  /** Idioma da legenda: o do aparelho, se houver modelo local; senão, o padrão. */
  async language(): Promise<string> {
    if (this.idiomaEscolhido) {
      return this.idiomaEscolhido;
    }
    const Motor = this.Motor;
    const doAparelho = navigator.language;
    if (Motor?.available && doAparelho && !doAparelho.startsWith('pt')) {
      try {
        const estado = await Motor.available({
          langs: [doAparelho],
          processLocally: true,
        });
        if (estado === 'available' || estado === 'downloadable') {
          this.idiomaEscolhido = doAparelho;
          return doAparelho;
        }
      } catch {
        // Cai no padrão.
      }
    }
    this.idiomaEscolhido = PADRAO;
    return PADRAO;
  }

  /** O que dá para fazer neste navegador, antes de prometer qualquer coisa. */
  async support(): Promise<CaptionSupport> {
    const Motor = this.Motor;
    if (!Motor || typeof Motor.available !== 'function') {
      return 'unsupported';
    }
    try {
      const estado = await Motor.available({
        langs: [await this.language()],
        processLocally: true,
      });
      if (estado === 'available') return 'ready';
      if (estado === 'downloadable' || estado === 'downloading') return 'downloadable';
      return 'no-device';
    } catch {
      return 'unsupported';
    }
  }

  /** Baixa o pacote de idioma. Pesado e uma vez só — daí o aviso na tela. */
  async install(): Promise<boolean> {
    const Motor = this.Motor;
    if (!Motor || typeof Motor.install !== 'function') {
      return false;
    }
    this.installing.set(true);
    try {
      return await Motor.install({
        langs: [await this.language()],
        processLocally: true,
      });
    } catch {
      return false;
    } finally {
      this.installing.set(false);
    }
  }

  async start(): Promise<boolean> {
    const Motor = this.Motor;
    if (!Motor || this.recognition) {
      return !!this.recognition;
    }

    const suporte = await this.support();
    if (suporte === 'downloadable' && !(await this.install())) {
      return false;
    }
    if (suporte === 'unsupported' || suporte === 'no-device') {
      return false;
    }

    const motor = new Motor();
    motor.lang = await this.language();
    motor.continuous = true;
    motor.interimResults = true;
    // A regra da casa: nada de áudio saindo para reconhecimento remoto.
    motor.processLocally = true;

    motor.onresult = (evento: SpeechRecognitionEvent) => {
      for (let i = evento.resultIndex; i < evento.results.length; i += 1) {
        const resultado = evento.results[i];
        const texto = resultado[0]?.transcript?.trim();
        if (texto) {
          this.chunks.next({ text: texto, final: resultado.isFinal });
        }
      }
    };

    // O motor encerra sozinho depois de um silêncio; enquanto o microfone
    // estiver aberto, ele volta.
    motor.onend = () => {
      if (this.querendoOuvir && this.recognition === motor) {
        try {
          motor.start();
        } catch {
          this.recognition = null;
        }
      }
    };

    motor.onerror = (evento: SpeechRecognitionErrorEvent) => {
      // `no-speech` e `aborted` são rotina; o resto desliga a legenda.
      if (evento.error !== 'no-speech' && evento.error !== 'aborted') {
        this.stop();
      }
    };

    this.recognition = motor;
    this.querendoOuvir = true;
    try {
      motor.start();
      return true;
    } catch {
      this.recognition = null;
      this.querendoOuvir = false;
      return false;
    }
  }

  stop(): void {
    this.querendoOuvir = false;
    const motor = this.recognition;
    this.recognition = null;
    try {
      motor?.stop();
    } catch {
      // Já parado: nada a fazer.
    }
  }
}
