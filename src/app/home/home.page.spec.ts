import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { provideRouter } from '@angular/router';
import { IonicModule } from '@ionic/angular';

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

  it('só libera criar sala com apelido e nome preenchidos', () => {
    component.nick = 'ana';
    component.roomName = '';
    expect(component.canCreate).toBeFalse();

    component.roomName = 'conversa';
    expect(component.canCreate).toBeTrue();

    component.busy = true;
    expect(component.canCreate).toBeFalse();
  });
});
