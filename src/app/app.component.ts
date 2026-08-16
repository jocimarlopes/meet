import { Component, inject, NgZone, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { MenuController } from '@ionic/angular';
import { filter } from 'rxjs';

import { ThemeService } from './core/services/theme.service';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
  standalone: false,
})
export class AppComponent {
  // Injetado aqui de propósito: serviços `providedIn: 'root'` só nascem no
  // primeiro uso, e enquanto só o chat o injetava a home abria sempre no tema
  // claro, trocando de aparência ao entrar na conversa.
  private readonly theme = inject(ThemeService);
  private readonly router = inject(Router);
  private readonly menu = inject(MenuController);
  private readonly zone = inject(NgZone);

  /**
   * A conversa é tela cheia, com os controles nos cantos. Um menu deslizando
   * por cima do vídeo, ou abrindo por gesto durante a chamada, atrapalharia —
   * por isso ele só existe fora dela.
   */
  readonly menuDisabled = signal(false);

  readonly links = [
    { titulo: 'Criar sala', rota: '/home', icone: 'add-circle-outline' },
    { titulo: 'Salas', rota: '/salas', icone: 'people-outline' },
    { titulo: 'Sobre', rota: '/sobre', icone: 'information-circle-outline' },
  ];

  readonly rotaAtual = signal('/home');

  constructor() {
    this.router.events
      .pipe(filter((evento): evento is NavigationEnd => evento instanceof NavigationEnd))
      .subscribe((evento) => {
        const url = evento.urlAfterRedirects;
        this.rotaAtual.set(url);
        this.menuDisabled.set(url.startsWith('/chat'));
      });

    // Deep link: link de convite abre o app em vez do navegador.
    if (Capacitor.isNativePlatform()) {
      CapApp.addListener('appUrlOpen', ({ url }) => {
        // url = https://jocimarlopes.github.io/meet/entrar/CODE
        try {
          const rota = new URL(url).pathname.replace(/^\/meet/, '');
          if (rota.startsWith('/entrar/')) {
            this.zone.run(() => this.router.navigateByUrl(rota));
          }
        } catch {
          // URL inválida: ignora.
        }
      });
    }
  }

  async fechar(): Promise<void> {
    await this.menu.close();
  }
}
