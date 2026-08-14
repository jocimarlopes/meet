import { Injectable, signal } from '@angular/core';

export type Theme = 'light' | 'dark';

/** Classe que o Ionic usa para aplicar a paleta escura (dark.class.css). */
const DARK_CLASS = 'ion-palette-dark';

/**
 * Tema claro ou escuro.
 *
 * Começa seguindo a preferência do sistema e aceita ser contrariado durante a
 * sessão. A escolha não é gravada de propósito: o app promete não deixar
 * rastro, e um valor em localStorage seria justamente um vestígio de que
 * alguém esteve aqui.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<Theme>('dark');

  constructor() {
    this.apply(this.systemPreference());
  }

  get isDark(): boolean {
    return this.theme() === 'dark';
  }

  toggle(): void {
    this.apply(this.isDark ? 'light' : 'dark');
  }

  apply(theme: Theme): void {
    this.theme.set(theme);
    document.documentElement.classList.toggle(DARK_CLASS, theme === 'dark');
  }

  private systemPreference(): Theme {
    return window.matchMedia?.('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
  }
}
