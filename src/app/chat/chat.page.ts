import { Component, ElementRef, ViewChild, effect, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AlertController, IonContent, ToastController } from '@ionic/angular';

import { ChatService } from '../core/services/chat.service';
import { SoundService } from '../core/services/sound.service';

@Component({
  selector: 'app-chat',
  templateUrl: 'chat.page.html',
  styleUrls: ['chat.page.scss'],
  standalone: false,
})
export class ChatPage {
  private readonly router = inject(Router);
  private readonly alerts = inject(AlertController);
  private readonly toasts = inject(ToastController);
  readonly chat = inject(ChatService);
  readonly sound = inject(SoundService);

  @ViewChild(IonContent) private content?: IonContent;

  // Os elementos de vídeo vivem dentro de *ngIf, então aparecem e somem. O
  // setter religa o stream sempre que o elemento é recriado; o effect cobre o
  // caminho inverso, quando o stream muda com o elemento já na tela.
  @ViewChild('localVideo') set localVideoRef(ref: ElementRef<HTMLVideoElement> | undefined) {
    this.localVideo = ref?.nativeElement;
    this.bind(this.localVideo, this.chat.localStream());
  }

  @ViewChild('remoteVideo') set remoteVideoRef(ref: ElementRef<HTMLVideoElement> | undefined) {
    this.remoteVideo = ref?.nativeElement;
    this.bind(this.remoteVideo, this.chat.remoteStream());
  }

  private localVideo?: HTMLVideoElement;
  private remoteVideo?: HTMLVideoElement;

  draft = '';
  showFingerprints = false;
  cameraBusy = false;

  constructor() {
    effect(() => this.bind(this.localVideo, this.chat.localStream()));
    effect(() => this.bind(this.remoteVideo, this.chat.remoteStream()));

    // Sessão encerrada (saída, erro do servidor, F5): volta para o lobby.
    effect(() => {
      if (this.chat.status() === 'idle') {
        void this.router.navigate(['/home']);
      }
    });

    effect(() => {
      this.chat.messages();
      queueMicrotask(() => this.scrollToBottom());
    });
  }

  get statusLabel(): string {
    switch (this.chat.status()) {
      case 'preparing':
        return 'gerando suas chaves…';
      case 'waiting':
        return 'aguardando alguém entrar';
      case 'connecting':
        return 'negociando conexão direta…';
      case 'connected':
        return 'conectado ponta a ponta';
      case 'ended':
        return 'conversa encerrada';
      default:
        return '';
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
    } catch {
      this.draft = text;
      await this.toast('Não foi possível enviar. O canal caiu?', 'danger');
    }
  }

  async toggleCamera(): Promise<void> {
    if (this.cameraBusy || !this.chat.canSend()) {
      return;
    }
    this.cameraBusy = true;
    try {
      await this.chat.toggleCamera();
    } catch (cause) {
      await this.toast(this.cameraFailure(cause), 'danger');
    } finally {
      this.cameraBusy = false;
    }
  }

  /** Traduz o erro do getUserMedia para algo acionável. */
  private cameraFailure(cause: unknown): string {
    const name = cause instanceof DOMException ? cause.name : '';
    if (name === 'NotAllowedError') {
      return 'Permissão de câmera negada. Libere nas configurações do site.';
    }
    if (name === 'NotFoundError') {
      return 'Nenhuma câmera encontrada neste dispositivo.';
    }
    if (name === 'NotReadableError') {
      return 'A câmera está em uso por outro programa.';
    }
    return 'Não foi possível abrir a câmera.';
  }

  private bind(element: HTMLVideoElement | undefined, stream: MediaStream | null): void {
    if (!element || element.srcObject === stream) {
      return;
    }
    element.srcObject = stream;
    if (stream) {
      void element.play().catch(() => undefined);
    }
  }

  async copyRoomId(): Promise<void> {
    const id = this.chat.room()?.id;
    if (!id) {
      return;
    }
    await navigator.clipboard.writeText(id);
    await this.toast('Id da sala copiado.', 'success');
  }

  async confirmLeave(): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Sair da conversa?',
      message:
        'A conexão é encerrada e o histórico some — ele só existe nesta aba.',
      buttons: [
        { text: 'Ficar', role: 'cancel' },
        { text: 'Sair', role: 'destructive', handler: () => this.chat.leave() },
      ],
    });
    await alert.present();
  }

  private scrollToBottom(): void {
    void this.content?.scrollToBottom(200);
  }

  private async toast(message: string, color: string): Promise<void> {
    const toast = await this.toasts.create({ message, color, duration: 2500 });
    await toast.present();
  }
}
