import { Component, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ToastController } from '@ionic/angular';

import { Visibility, isValidNick } from '../core/models/signaling.models';
import { ChatService } from '../core/services/chat.service';
import { SoundService } from '../core/services/sound.service';
import { ThemeService } from '../core/services/theme.service';

/** Mesmo teto do `RoomName` no backend — passar disso é rejeitado lá. */
const ROOM_NAME_MAX = 48;

/**
 * A primeira tela faz uma coisa só: abrir uma conversa.
 *
 * A lista de salas e o texto explicativo saíram daqui para o menu lateral. Os
 * dois eram bons, mas empurravam para baixo a única ação que importa neste
 * momento. A tela também atende o link de convite, onde ela vira o oposto:
 * pede o apelido e entra numa sala que já existe.
 */
@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: false,
})
export class HomePage {
  private readonly chat = inject(ChatService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastController);
  private readonly sound = inject(SoundService);
  private readonly route = inject(ActivatedRoute);
  readonly theme = inject(ThemeService);

  nick = '';
  inviteCode = '';
  /** Assunto da sala. Só faz sentido na pública, que estranhos leem na lista. */
  roomName = '';
  busy = false;
  visibility: Visibility = 'private';
  /** Chegou por link de convite ou pela lista: só falta o apelido. */
  invited = false;
  /** Nome da sala escolhida na lista, quando veio de lá. */
  joiningRoomName = '';

  get nickIsValid(): boolean {
    return isValidNick(this.nick);
  }

  /** Vazio vale: a sala herda o nome de quem abriu. */
  get roomNameIsValid(): boolean {
    return this.roomName.trim().length <= ROOM_NAME_MAX;
  }

  get canCreate(): boolean {
    return this.nickIsValid && this.roomNameIsValid && !this.busy;
  }

  get canJoin(): boolean {
    return this.nickIsValid && this.inviteCode.trim().length > 0 && !this.busy;
  }

  /** O botão é um só: cria a sala ou entra, conforme veio ou não por link. */
  get canSubmit(): boolean {
    return this.invited ? this.canJoin : this.canCreate;
  }

  async submit(): Promise<void> {
    await (this.invited ? this.joinRoom() : this.createRoom());
  }

  ionViewWillEnter(): void {
    // Uma sessão anterior pode ter ficado pendurada ao voltar para cá.
    this.chat.leave();
    void this.showPendingError();

    const code = this.route.snapshot.paramMap.get('code');
    this.invited = !!code;
    this.inviteCode = code ?? '';
    // Quem chegou pela lista de salas trouxe o assunto junto, e a tela pode
    // dizer onde a pessoa está entrando em vez de um "você foi convidado" seco.
    this.joiningRoomName =
      (this.router.getCurrentNavigation()?.extras.state?.['roomName'] as string) ??
      (history.state?.['roomName'] as string) ??
      '';
  }

  async createRoom(): Promise<void> {
    if (!this.canCreate) {
      return;
    }
    await this.enterSession(() =>
      // O assunto é só da sala pública; na privada ninguém de fora o leria.
      this.chat.createRoom(
        this.nick.trim(),
        this.visibility,
        this.visibility === 'public' ? this.roomName : '',
      ),
    );
  }

  async joinRoom(): Promise<void> {
    if (!this.canJoin) {
      return;
    }
    await this.enterSession(() =>
      this.chat.joinRoom(this.inviteCode.trim(), this.nick.trim()),
    );
  }

  private async enterSession(action: () => Promise<void>): Promise<void> {
    // Estamos dentro do clique: é a única janela em que o navegador libera
    // áudio. Os avisos sonoros tocam bem depois disso.
    this.sound.unlock();
    this.busy = true;
    try {
      await action();
      await this.router.navigate(['/chat']);
    } catch (cause) {
      await this.toast(
        cause instanceof Error ? cause.message : 'Não foi possível abrir a sala.',
        'danger',
      );
    } finally {
      this.busy = false;
    }
  }

  /** Erro devolvido pelo servidor depois que a sessão já tinha começado. */
  private async showPendingError(): Promise<void> {
    const error = this.chat.error();
    if (error) {
      this.chat.error.set(null);
      await this.toast(error, 'danger');
    }
  }

  private async toast(message: string, color: string): Promise<void> {
    const toast = await this.toasts.create({ message, color, duration: 3000 });
    await toast.present();
  }
}
