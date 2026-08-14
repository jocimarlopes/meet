import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { RoomView } from '../models/signaling.models';

/**
 * Listagem das salas públicas — o único endpoint REST do backend.
 *
 * Salas privadas nunca aparecem aqui: são alcançáveis só por quem tem o link.
 */
@Injectable({ providedIn: 'root' })
export class RoomsService {
  private readonly http = inject(HttpClient);

  listPublicRooms(): Observable<RoomView[]> {
    return this.http.get<RoomView[]>(`${environment.apiUrl}/rooms`);
  }
}
