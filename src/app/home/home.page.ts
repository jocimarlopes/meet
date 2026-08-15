import { Component, OnDestroy, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ToastController } from '@ionic/angular';
import {
  Subscription,
  filter,
  fromEvent,
  interval,
  merge,
  startWith,
  switchMap,
  throttleTime,
} from 'rxjs';

import { RoomView, Visibility, isValidNick } from '../core/models/signaling.models';
import { ChatService } from '../core/services/chat.service';
import { RoomsService } from '../core/services/rooms.service';
import { SoundService } from '../core/services/sound.service';
import { ThemeService } from '../core/services/theme.service';

// Cada consulta é uma invocação de função, mas quem está olhando a vitrine está
// esperando alguém abrir uma sala: espaçar demais faz a lista parecer quebrada.
// O que economiza de verdade é não consultar com a aba escondida, logo abaixo.
const REFRESH_INTERVAL_MS = 5_000;
/** Evita consulta dupla quando `focus` e `visibilitychange` chegam juntos. */
const COALESCE_MS = 1_000;
/** Mesmo teto do `RoomName` no backend — passar disso é rejeitado lá. */
const ROOM_NAME_MAX = 48;

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: false,
})
export class HomePage implements OnDestroy {
  private readonly chat = inject(ChatService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastController);
  private readonly sound = inject(SoundService);
  private readonly route = inject(ActivatedRoute);
  private readonly rooms = inject(RoomsService);
  readonly theme = inject(ThemeService);

  nick = '';
  inviteCode = '';
  /** Assunto da sala. Só faz sentido na pública, que estranhos leem na lista. */
  roomName = '';
  busy = false;
  visibility: Visibility = 'private';
  publicRooms: RoomView[] = [];
  /** A vitrine só se mostra depois da primeira resposta, cheia ou vazia. */
  roomsLoaded = false;
  /** Chegou por link de convite: só falta o apelido. */
  invited = false;

  private polling?: Subscription;

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
    if (code) {
      this.inviteCode = code;
      this.invited = true;
      return;
    }
    this.startPolling();
  }

  ionViewWillLeave(): void {
    this.stopPolling();
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  private startPolling(): void {
    this.stopPolling();
    this.polling = merge(
      interval(REFRESH_INTERVAL_MS),
      // Voltar para esta aba ou para esta janela atualiza na hora. Sem isso,
      // quem alterna entre janelas encara a lista velha até o próximo ciclo —
      // e conclui, com razão, que a sala do amigo nunca apareceu.
      fromEvent(document, 'visibilitychange'),
      fromEvent(window, 'focus'),
    )
      .pipe(
        startWith(0),
        throttleTime(COALESCE_MS),
        // Aba escondida não precisa de lista atualizada, e quem esquece a
        // página aberta não deveria custar nada.
        filter(() => !document.hidden),
        switchMap(() => this.rooms.listPublicRooms()),
      )
      .subscribe({
        next: (rooms) => {
          this.publicRooms = rooms;
          this.roomsLoaded = true;
        },
        // Sem servidor a vitrine só fica vazia; criar sala por link continua
        // valendo, então não vale interromper a tela com erro.
        error: () => setTimeout(() => this.startPolling(), REFRESH_INTERVAL_MS),
      });
  }

  private stopPolling(): void {
    this.polling?.unsubscribe();
    this.polling = undefined;
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

  /** Entrar numa sala da vitrine é igual a entrar por link: só falta o apelido. */
  async joinPublic(room: RoomView): Promise<void> {
    if (!this.nickIsValid) {
      await this.toast('Escolha um apelido antes de entrar.', 'warning');
      return;
    }
    await this.enterSession(() => this.chat.joinRoom(room.id, this.nick.trim()));
  }

  trackRoom(_index: number, room: RoomView): string {
    return room.id;
  }

  vagas(room: RoomView): number {
    return room.capacity - room.occupants;
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
