import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { RoomView } from '../models/signaling.models';

/** Listagem pública de salas — o único endpoint REST do backend. */
@Injectable({ providedIn: 'root' })
export class RoomsService {
  private readonly http = inject(HttpClient);

  listOpenRooms(): Observable<RoomView[]> {
    return this.http.get<RoomView[]>(`${environment.apiUrl}/rooms`);
  }
}
