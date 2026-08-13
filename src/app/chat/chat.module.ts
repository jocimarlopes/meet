import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonicModule } from '@ionic/angular';

import { SrcObjectDirective } from '../core/directives/src-object.directive';
import { ChatPage } from './chat.page';
import { ChatPageRoutingModule } from './chat-routing.module';

@NgModule({
  imports: [CommonModule, FormsModule, IonicModule, ChatPageRoutingModule],
  declarations: [ChatPage, SrcObjectDirective],
})
export class ChatPageModule {}
