import { TestBed } from '@angular/core/testing';

import { SoundService } from './sound.service';

describe('SoundService', () => {
  let sound: SoundService;
  let createOscillator: jasmine.Spy;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    sound = TestBed.inject(SoundService);
    // Espiona no prototype: o contexto é criado lá dentro, sob demanda.
    createOscillator = spyOn(AudioContext.prototype, 'createOscillator').and.callThrough();
  });

  it('começa com o som ligado', () => {
    expect(sound.muted()).toBeFalse();
  });

  it('toca duas notas quando alguém entra na sala', () => {
    sound.peerJoined();
    expect(createOscillator).toHaveBeenCalledTimes(2);
  });

  it('toca uma nota quando chega mensagem', () => {
    sound.messageReceived();
    expect(createOscillator).toHaveBeenCalledTimes(1);
  });

  it('não toca nada quando silenciado', () => {
    sound.toggleMute();
    expect(sound.muted()).toBeTrue();

    sound.peerJoined();
    sound.messageReceived();
    expect(createOscillator).not.toHaveBeenCalled();
  });

  it('volta a tocar ao reativar', () => {
    sound.toggleMute();
    sound.toggleMute();

    sound.messageReceived();
    expect(createOscillator).toHaveBeenCalledTimes(1);
  });

  it('reaproveita o mesmo AudioContext entre toques', () => {
    const constructed = spyOn(window, 'AudioContext').and.callThrough();
    sound.unlock();
    sound.messageReceived();
    sound.peerJoined();
    expect(constructed).toHaveBeenCalledTimes(1);
  });
});
