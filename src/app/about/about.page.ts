import { Component } from '@angular/core';

/**
 * O que a home explicava.
 *
 * Estava tudo na primeira tela: o que é o projeto, como a malha funciona, o
 * prazo da sala e as garantias. Informação boa, mas empurrava para baixo a
 * única coisa que a home precisa fazer, que é abrir uma conversa.
 */
@Component({
  selector: 'app-about',
  templateUrl: 'about.page.html',
  styleUrls: ['about.page.scss'],
  standalone: false,
})
export class AboutPage {}
