import { NgModule } from '@angular/core';
import { PreloadAllModules, RouterModule, Routes } from '@angular/router';

const routes: Routes = [
  {
    path: 'home',
    loadChildren: () => import('./home/home.module').then((m) => m.HomePageModule),
  },
  {
    path: 'chat',
    loadChildren: () => import('./chat/chat.module').then((m) => m.ChatPageModule),
  },
  {
    // Link de convite: cai na mesma tela, já com o código preenchido.
    path: 'entrar/:code',
    loadChildren: () => import('./home/home.module').then((m) => m.HomePageModule),
  },
  {
    path: '',
    redirectTo: 'home',
    pathMatch: 'full',
  },
  {
    path: '**',
    redirectTo: 'home',
  },
];

@NgModule({
  imports: [
    // Rotas por caminho, sem `#`. O GitHub Pages não tem fallback de rota, e é
    // por isso que o deploy publica um 404.html idêntico ao index: o Pages o
    // devolve em qualquer caminho desconhecido, o app inicia e a rota resolve.
    RouterModule.forRoot(routes, {
      preloadingStrategy: PreloadAllModules,
    }),
  ],
  exports: [RouterModule],
})
export class AppRoutingModule {}
