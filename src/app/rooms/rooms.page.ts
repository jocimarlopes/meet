import { Component, OnDestroy, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription, filter, fromEvent, merge, throttleTime } from 'rxjs';

import { RoomView } from '../core/models/signaling.models';
import { RoomsService } from '../core/services/rooms.service';

/** Evita consulta dupla quando `focus` e `visibilitychange` chegam juntos. */
const COALESCE_MS = 1_000;

/**
 * A vitrine de salas públicas.
 *
 * Saiu da home para que ela ficasse só com o ato de criar. Escolher uma sala
 * aqui leva para a mesma tela de quem chega por link de convite: é o mesmo
 * caminho, e é lá que o apelido é pedido.
 */
@Component({
  selector: 'app-rooms',
  templateUrl: 'rooms.page.html',
  styleUrls: ['rooms.page.scss'],
  standalone: false,
})
export class RoomsPage implements OnDestroy {
  private readonly rooms = inject(RoomsService);
  private readonly router = inject(Router);

  publicRooms: RoomView[] = [];
  roomsLoading = false;
  /** Sem servidor a vitrine explica o silêncio, em vez de fingir sala nenhuma. */
  roomsError = false;

  private wake?: Subscription;
  private listing?: Subscription;

  ionViewWillEnter(): void {
    this.watchForeground();
    this.refreshRooms();
  }

  ionViewWillLeave(): void {
    this.stopWatching();
  }

  ngOnDestroy(): void {
    this.stopWatching();
  }

  /** Botão de atualizar, e também o carregamento inicial da vitrine. */
  refreshRooms(): void {
    if (this.roomsLoading) {
      return;
    }
    this.roomsLoading = true;
    this.listing?.unsubscribe();
    this.listing = this.rooms.listPublicRooms().subscribe({
      next: (rooms) => {
        this.publicRooms = rooms;
        this.roomsError = false;
        this.roomsLoading = false;
      },
      // Criar sala e entrar por link não dependem disto, então o erro fica na
      // própria vitrine em vez de interromper a tela.
      error: () => {
        this.roomsError = true;
        this.roomsLoading = false;
      },
    });
  }

  /**
   * Entrar numa sala da lista é igual a abrir um link de convite: a tela
   * seguinte pede o apelido. O nome da sala vai junto para ela poder dizer
   * onde você está entrando.
   */
  async enter(room: RoomView): Promise<void> {
    await this.router.navigate(['/entrar', room.id], {
      state: { roomName: room.name },
    });
  }

  trackRoom(_index: number, room: RoomView): string {
    return room.id;
  }

  vagas(room: RoomView): number {
    return room.capacity - room.occupants;
  }

  /**
   * Voltar para esta aba ou para esta janela recarrega a lista. É o gesto de
   * quem alterna entre dois navegadores para testar, e não custa nada enquanto
   * ninguém está olhando.
   */
  private watchForeground(): void {
    this.stopWatching();
    this.wake = merge(
      fromEvent(document, 'visibilitychange'),
      fromEvent(window, 'focus'),
    )
      .pipe(
        throttleTime(COALESCE_MS),
        filter(() => !document.hidden),
      )
      .subscribe(() => this.refreshRooms());
  }

  private stopWatching(): void {
    this.wake?.unsubscribe();
    this.wake = undefined;
    this.listing?.unsubscribe();
    this.listing = undefined;
  }
}
