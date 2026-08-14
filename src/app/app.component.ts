import { Component, inject } from '@angular/core';

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
}
