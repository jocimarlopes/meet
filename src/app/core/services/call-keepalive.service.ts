import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';

interface CallKeepAlivePlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const CallKeepAlive = registerPlugin<CallKeepAlivePlugin>('CallKeepAlive');

/**
 * Mantém a conversa viva com o aplicativo em segundo plano.
 *
 * Existe por uma regra do Android, não por escolha: desde o Android 9,
 * aplicativo em segundo plano não acessa o microfone sem um serviço em
 * primeiro plano declarado com o tipo `microphone`. Medido antes disso, a
 * chamada morria em menos de 30 segundos depois de sair do app — o áudio
 * parava e o processo era congelado.
 *
 * Na web não há equivalente: navegador em segundo plano perde o microfone e
 * ponto. Por isso aqui vira um no-op silencioso em vez de um erro.
 */
@Injectable({ providedIn: 'root' })
export class CallKeepAliveService {
  private ligado = false;

  private get disponivel(): boolean {
    return Capacitor.isNativePlatform();
  }

  /** Liga e desliga conforme a conversa começa e acaba. */
  async set(ativo: boolean): Promise<void> {
    if (!this.disponivel || ativo === this.ligado) {
      return;
    }
    this.ligado = ativo;
    try {
      await (ativo ? CallKeepAlive.start() : CallKeepAlive.stop());
    } catch {
      // Falhar aqui não pode derrubar a conversa: sem o serviço ela continua
      // funcionando enquanto o app estiver à vista, que é o caso comum.
      this.ligado = !ativo;
    }
  }
}
