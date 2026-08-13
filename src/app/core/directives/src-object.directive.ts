import { Directive, ElementRef, EventEmitter, Input, Output, inject } from '@angular/core';

/**
 * Liga um MediaStream a um <video> ou <audio>.
 *
 * `srcObject` não é atributo HTML, então não dá para vincular por template do
 * jeito comum — e numa sala em malha há um elemento por participante, o que
 * inviabiliza resolver com ViewChild.
 */
@Directive({
  selector: '[srcObjectRef]',
  standalone: false,
})
export class SrcObjectDirective {
  private readonly element = inject<ElementRef<HTMLMediaElement>>(ElementRef);

  /** Emitido quando a política de autoplay barra a reprodução. */
  @Output() readonly playbackBlocked = new EventEmitter<void>();

  @Input()
  set srcObjectRef(stream: MediaStream | null) {
    const media = this.element.nativeElement;
    if (media.srcObject === stream) {
      return;
    }
    media.srcObject = stream;
    if (stream) {
      void media.play().catch(() => this.playbackBlocked.emit());
    }
  }
}
