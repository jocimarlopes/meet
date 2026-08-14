import { Component, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ToastController } from '@ionic/angular';

import { isValidNick } from '../core/models/signaling.models';
import { ChatService } from '../core/services/chat.service';
import { SoundService } from '../core/services/sound.service';
import { ThemeService } from '../core/services/theme.service';

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
  busy = false;
  /** Chegou por link de convite: só falta o apelido. */
  invited = false;

  get nickIsValid(): boolean {
    return isValidNick(this.nick);
  }

  get canCreate(): boolean {
    return this.nickIsValid && !this.busy;
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
    if (code) {
      this.inviteCode = code;
      this.invited = true;
    }
  }

  async createRoom(): Promise<void> {
    if (!this.canCreate) {
      return;
    }
    await this.enterSession(() => this.chat.createRoom(this.nick.trim()));
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
