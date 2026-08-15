import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { Router, provideRouter } from '@angular/router';
import { IonicModule } from '@ionic/angular';

import { of, throwError } from 'rxjs';

import { ChatService } from '../core/services/chat.service';
import { RoomsService } from '../core/services/rooms.service';
import { HomePage } from './home.page';

describe('HomePage', () => {
  let component: HomePage;
  let fixture: ComponentFixture<HomePage>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [HomePage],
      imports: [IonicModule.forRoot(), FormsModule],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(HomePage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('cria o componente', () => {
    expect(component).toBeTruthy();
  });

  it('rejeita apelidos fora do formato aceito pelo backend', () => {
    for (const invalid of ['', ' ', 'a', 'nick@casa', 'x'.repeat(25)]) {
      component.nick = invalid;
      expect(component.nickIsValid)
        .withContext(`"${invalid}" deveria ser inválido`)
        .toBeFalse();
    }
  });

  it('aceita apelidos válidos', () => {
    for (const valid of ['ana', 'Jocimar L.', 'user_1', 'maria-clara']) {
      component.nick = valid;
      expect(component.nickIsValid).withContext(`"${valid}"`).toBeTrue();
    }
  });

  it('criar convite exige apenas o apelido', () => {
    component.nick = '';
    expect(component.canCreate).toBeFalse();

    component.nick = 'ana';
    expect(component.canCreate).toBeTrue();

    component.busy = true;
    expect(component.canCreate).toBeFalse();
  });

  it('a sala nasce privada', () => {
    expect(component.visibility).toEqual('private');
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

  it('o assunto da sala é opcional e limitado a 48 caracteres', () => {
    component.nick = 'ana';

    component.roomName = '';
    expect(component.canCreate).withContext('em branco vale').toBeTrue();

    component.roomName = 'Angular e Ionic';
    expect(component.canCreate).toBeTrue();

    component.roomName = 'x'.repeat(49);
    expect(component.roomNameIsValid).toBeFalse();
    expect(component.canCreate).withContext('o backend recusaria').toBeFalse();
  });

  it('o assunto só vai junto quando a sala é pública', async () => {
    const chat = TestBed.inject(ChatService);
    const createRoom = spyOn(chat, 'createRoom').and.resolveTo();
    spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);

    component.nick = 'ana';
    component.roomName = 'Angular e Ionic';

    await component.createRoom();
    expect(createRoom)
      .withContext('privada não mostra o assunto a ninguém')
      .toHaveBeenCalledWith('ana', 'private', '');

    component.visibility = 'public';
    await component.createRoom();
    expect(createRoom).toHaveBeenCalledWith('ana', 'public', 'Angular e Ionic');
  });

  it('entrar exige apelido e código do convite', () => {
    component.nick = 'ana';
    component.inviteCode = '';
    expect(component.canJoin).toBeFalse();

    component.inviteCode = '   ';
    expect(component.canJoin).withContext('só espaços não vale').toBeFalse();

    component.inviteCode = 'x6Lilyoj';
    expect(component.canJoin).toBeTrue();

    component.nick = 'a';
    expect(component.canJoin).withContext('apelido inválido barra').toBeFalse();
  });
});
