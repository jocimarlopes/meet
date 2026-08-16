import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { IonicModule } from '@ionic/angular';

import { of, throwError } from 'rxjs';

import { RoomsService } from '../core/services/rooms.service';
import { RoomsPage } from './rooms.page';

describe('RoomsPage', () => {
  let component: RoomsPage;
  let fixture: ComponentFixture<RoomsPage>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [RoomsPage],
      imports: [IonicModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(RoomsPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('a vitrine avisa quando não consegue consultar, em vez de sumir', () => {
    const rooms = TestBed.inject(RoomsService);
    spyOn(rooms, 'listPublicRooms').and.returnValue(throwError(() => new Error('offline')));

    component.refreshRooms();

    expect(component.roomsError).withContext('o erro fica visível').toBeTrue();
    expect(component.roomsLoading).withContext('o botão volta a funcionar').toBeFalse();
  });

  it('atualizar de novo limpa o erro anterior', () => {
    const rooms = TestBed.inject(RoomsService);
    const listar = spyOn(rooms, 'listPublicRooms').and.returnValue(
      throwError(() => new Error('offline')),
    );
    component.refreshRooms();
    expect(component.roomsError).toBeTrue();

    listar.and.returnValue(of([]));
    component.refreshRooms();

    expect(component.roomsError).toBeFalse();
    expect(component.publicRooms).toEqual([]);
  });

  it('conta as vagas a partir da lotação', () => {
    expect(component.vagas({ occupants: 3, capacity: 10 } as never)).toBe(7);
  });
});
