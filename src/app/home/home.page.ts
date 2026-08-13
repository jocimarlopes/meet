import { Component, OnDestroy, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ToastController } from '@ionic/angular';
import { Subscription, interval, startWith, switchMap } from 'rxjs';

import { RoomView, isValidNick } from '../core/models/signaling.models';
import { ChatService } from '../core/services/chat.service';
import { RoomsService } from '../core/services/rooms.service';
import { SoundService } from '../core/services/sound.service';

const REFRESH_INTERVAL_MS = 5_000;

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: false,
})
export class HomePage implements OnDestroy {
  private readonly chat = inject(ChatService);
  private readonly rooms = inject(RoomsService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastController);
  private readonly sound = inject(SoundService);

  nick = '';
  roomName = '';
  openRooms: RoomView[] = [];
  busy = false;
  offline = false;

  private polling?: Subscription;

  get nickIsValid(): boolean {
    return isValidNick(this.nick);
  }

  get canCreate(): boolean {
    return this.nickIsValid && this.roomName.trim().length > 0 && !this.busy;
  }

  ionViewWillEnter(): void {
    // Uma sessão anterior pode ter ficado pendurada ao voltar para o lobby.
    this.chat.leave();
    this.showPendingError();
    this.startPolling();
  }

  ionViewWillLeave(): void {
    this.stopPolling();
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  async createRoom(): Promise<void> {
    if (!this.canCreate) {
      return;
    }
    await this.enterSession(() =>
      this.chat.createRoom(this.roomName.trim(), this.nick.trim()),
    );
  }

  async joinRoom(room: RoomView): Promise<void> {
    if (!this.nickIsValid) {
      await this.toast('Escolha um apelido antes de entrar.', 'warning');
      return;
    }
    if (room.host_nick && room.host_nick.toLowerCase() === this.nick.trim().toLowerCase()) {
      await this.toast('Este apelido já é usado nesta sala.', 'warning');
      return;
    }
    await this.enterSession(() => this.chat.joinRoom(room.id, this.nick.trim()));
  }

  refresh(event?: CustomEvent): void {
    this.rooms.listOpenRooms().subscribe({
      next: (rooms) => {
        this.openRooms = rooms;
        this.offline = false;
        this.completeRefresh(event);
      },
      error: () => {
        this.offline = true;
        this.completeRefresh(event);
      },
    });
  }

  trackRoom(_index: number, room: RoomView): string {
    return room.id;
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

  private startPolling(): void {
    this.stopPolling();
    this.polling = interval(REFRESH_INTERVAL_MS)
      .pipe(
        startWith(0),
        switchMap(() => this.rooms.listOpenRooms()),
      )
      .subscribe({
        next: (rooms) => {
          this.openRooms = rooms;
          this.offline = false;
        },
        error: () => {
          this.offline = true;
          // O `interval` morre no erro; volta a tentar no próximo ciclo.
          setTimeout(() => this.startPolling(), REFRESH_INTERVAL_MS);
        },
      });
  }

  private stopPolling(): void {
    this.polling?.unsubscribe();
    this.polling = undefined;
  }

  private completeRefresh(event?: CustomEvent): void {
    (event?.target as HTMLIonRefresherElement | undefined)?.complete();
  }

  private async toast(message: string, color: string): Promise<void> {
    const toast = await this.toasts.create({ message, color, duration: 3000 });
    await toast.present();
  }
}
