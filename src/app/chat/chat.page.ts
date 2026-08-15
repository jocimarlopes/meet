import { Component, ElementRef, ViewChild, effect, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ToastController } from '@ionic/angular';

import { ChatMessage, ChatService, Participant } from '../core/services/chat.service';
import { SoundService } from '../core/services/sound.service';
import { ThemeService } from '../core/services/theme.service';

@Component({
  selector: 'app-chat',
  templateUrl: 'chat.page.html',
  styleUrls: ['chat.page.scss'],
  standalone: false,
})
export class ChatPage {
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastController);
  readonly chat = inject(ChatService);
  readonly sound = inject(SoundService);
  readonly theme = inject(ThemeService);

  @ViewChild('messageList') private messageList?: ElementRef<HTMLElement>;

  draft = '';
  showFingerprints = false;
  cameraBusy = false;
  micBusy = false;
  chatOpen = false;
  unread = 0;
  sendingImage = false;

  private lastSeenCount = 0;
  private warnedAboutAudio = false;

  constructor() {
    // Sessão encerrada (saída, erro do servidor, F5). Se veio de um convite e
    // a entrada falhou, volta para ele: assim dá para corrigir o apelido sem
    // precisar do link outra vez.
    effect(() => {
      if (this.chat.status() !== 'idle') {
        return;
      }
      const invite = this.chat.pendingInvite();
      void this.router.navigate(invite ? ['/entrar', invite] : ['/home']);
    });

    // Com a gaveta fechada, mensagens novas viram contador em vez de sumirem.
    effect(() => {
      const total = this.chat.messages().filter((m) => m.kind !== 'system').length;
      if (this.chatOpen) {
        this.lastSeenCount = total;
        this.unread = 0;
        queueMicrotask(() => this.scrollToBottom());
        return;
      }
      this.unread = Math.max(0, total - this.lastSeenCount);
    });
  }

  get statusLabel(): string {
    const connected = this.chat.connectedCount();
    switch (this.chat.status()) {
      case 'preparing':
        return 'gerando suas chaves…';
      case 'waiting':
        return 'aguardando alguém entrar';
      case 'connecting':
        return 'negociando conexão direta…';
      case 'connected':
        return connected === 1 ? 'conectado ponta a ponta' : `${connected} conectados`;
      case 'ended':
        return 'conversa encerrada';
      default:
        return '';
    }
  }

  /**
   * Link pronto para colar: quem abrir cai direto na tela de apelido.
   *
   * Montado a partir de `document.baseURI` para respeitar o base href do
   * deploy — em produção o app vive num subcaminho, não na raiz.
   */
  get inviteLink(): string {
    const id = this.chat.room()?.id;
    return id ? new URL(`entrar/${id}`, document.baseURI).href : '';
  }

  /** Tempo de conversa, no formato de cronômetro de chamada. */
  get elapsedLabel(): string {
    const segundos = this.chat.elapsedSeconds();
    if (segundos === null) {
      return '';
    }
    const minutos = Math.floor(segundos / 60);
    const resto = Math.floor(segundos % 60);
    return `${minutos}:${String(resto).padStart(2, '0')}`;
  }

  /** Tempo restante da sala, curto e legível. Vazio quando ainda sobra folga. */
  get timeLeftLabel(): string {
    const segundos = this.chat.secondsLeft();
    if (segundos === null) {
      return '';
    }
    const minutos = Math.floor(segundos / 60);
    return minutos >= 1
      ? `${minutos} min restantes`
      : `${Math.floor(segundos)}s restantes`;
  }

  /** Abaixo de 5 minutos o aviso ganha destaque. */
  get timeIsShort(): boolean {
    const segundos = this.chat.secondsLeft();
    return segundos !== null && segundos <= 300;
  }

  /** Iniciais para o quadro de quem está sem câmera. */
  initials(nick: string): string {
    const parts = nick.trim().split(/\s+/).filter(Boolean);
    const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : nick.slice(0, 2);
    return letters.toLocaleUpperCase();
  }

  toggleChat(): void {
    this.chatOpen = !this.chatOpen;
    if (this.chatOpen) {
      this.lastSeenCount = this.chat.messages().filter((m) => m.kind !== 'system').length;
      this.unread = 0;
      queueMicrotask(() => this.scrollToBottom());
    }
  }

  /** Escolha de arquivo: prepara, cifra e manda pela malha. */
  async pickImage(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // Zera já: escolher a mesma foto duas vezes seguidas não dispara `change`.
    input.value = '';
    if (!file || !this.chat.canSend()) {
      return;
    }

    this.sendingImage = true;
    try {
      await this.chat.sendImage(file);
      queueMicrotask(() => this.scrollToBottom());
    } catch (cause) {
      await this.toast(
        cause instanceof Error ? cause.message : 'Não foi possível enviar a imagem.',
        'danger',
      );
    } finally {
      this.sendingImage = false;
    }
  }

  openImage(message: ChatMessage): void {
    if (message.image) {
      window.open(message.image.url, '_blank');
    }
  }

  async send(): Promise<void> {
    const text = this.draft.trim();
    if (!text || !this.chat.canSend()) {
      return;
    }
    this.draft = '';
    try {
      await this.chat.send(text);
      queueMicrotask(() => this.scrollToBottom());
    } catch {
      this.draft = text;
      await this.toast('Não foi possível enviar. O canal caiu?', 'danger');
    }
  }

  async toggleCamera(): Promise<void> {
    if (this.cameraBusy || !this.chat.canUseMedia()) {
      return;
    }
    this.cameraBusy = true;
    try {
      await this.chat.toggleCamera();
    } catch (cause) {
      await this.toast(this.mediaFailure(cause, 'câmera'), 'danger');
    } finally {
      this.cameraBusy = false;
    }
  }

  async toggleMic(): Promise<void> {
    if (this.micBusy || !this.chat.canUseMedia()) {
      return;
    }
    this.micBusy = true;
    try {
      await this.chat.toggleMic();
    } catch (cause) {
      await this.toast(this.mediaFailure(cause, 'microfone'), 'danger');
    } finally {
      this.micBusy = false;
    }
  }

  async copyInviteLink(): Promise<void> {
    const link = this.inviteLink;
    if (!link) {
      return;
    }
    await navigator.clipboard.writeText(link);
    await this.toast('Link do convite copiado.', 'success');
  }

  async onAudioBlocked(): Promise<void> {
    if (this.warnedAboutAudio) {
      return;
    }
    this.warnedAboutAudio = true;
    await this.toast('Toque na tela para liberar o áudio da conversa.', 'warning');
  }

  trackByNick(_index: number, entry: { nick: string }): string {
    return entry.nick;
  }

  trackByPeer(_index: number, peer: Participant): string {
    return peer.nick;
  }

  /** Traduz o erro do getUserMedia para algo acionável. */
  private mediaFailure(cause: unknown, device: string): string {
    const name = cause instanceof DOMException ? cause.name : '';
    if (name === 'NotAllowedError') {
      return `Permissão de ${device} negada. Libere nas configurações do site.`;
    }
    if (name === 'NotFoundError') {
      return `Nenhum dispositivo de ${device} encontrado.`;
    }
    if (name === 'NotReadableError') {
      return `O ${device} está em uso por outro programa.`;
    }
    return `Não foi possível abrir o ${device}.`;
  }

  private scrollToBottom(): void {
    const element = this.messageList?.nativeElement;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }

  private async toast(message: string, color: string): Promise<void> {
    const toast = await this.toasts.create({ message, color, duration: 2500 });
    await toast.present();
  }
}
