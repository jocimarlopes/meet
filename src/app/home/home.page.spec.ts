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
      providers: [provideRouter([])],
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
