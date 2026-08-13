import { TestBed } from '@angular/core/testing';

import { Identity, PeerIdentity, PgpService } from './pgp.service';

describe('PgpService', () => {
  let pgp: PgpService;
  let ana: Identity;
  let bob: Identity;
  let anaAsPeer: PeerIdentity;
  let bobAsPeer: PeerIdentity;

  beforeAll(async () => {
    TestBed.configureTestingModule({});
    pgp = TestBed.inject(PgpService);

    ana = await pgp.generateIdentity('ana');
    bob = await pgp.generateIdentity('bob');
    // Cada lado importa a chave do outro como se tivesse vindo do signaling.
    anaAsPeer = await pgp.importPeerKey('ana', ana.publicKeyArmored);
    bobAsPeer = await pgp.importPeerKey('bob', bob.publicKeyArmored);
  });

  it('gera identidades distintas', () => {
    expect(ana.fingerprint).not.toEqual(bob.fingerprint);
    expect(ana.publicKeyArmored).toContain('BEGIN PGP PUBLIC KEY BLOCK');
  });

  it('recalcula a impressão digital a partir da chave recebida', () => {
    expect(anaAsPeer.fingerprint).toEqual(ana.fingerprint);
  });

  it('faz o ciclo cifrar/decifrar entre os dois peers', async () => {
    const text = 'segredo com acento e emoji 🔐';
    const armored = await pgp.encryptFor(ana, bobAsPeer, text);

    expect(armored).toContain('BEGIN PGP MESSAGE');
    expect(armored).not.toContain('segredo');

    const decrypted = await pgp.decryptFrom(bob, anaAsPeer, armored);
    expect(decrypted.text).toEqual(text);
    expect(decrypted.verified).toBeTrue();
  });

  it('não decifra mensagem destinada a outra pessoa', async () => {
    const armored = await pgp.encryptFor(ana, bobAsPeer, 'só para o bob');
    await expectAsync(pgp.decryptFrom(ana, bobAsPeer, armored)).toBeRejected();
  });

  it('marca como não verificada a mensagem assinada por um terceiro', async () => {
    const impostor = await pgp.generateIdentity('impostor');
    const armored = await pgp.encryptFor(impostor, bobAsPeer, 'oi, sou a ana');

    // Bob decifra achando que veio da Ana: o texto sai, mas sem selo.
    const decrypted = await pgp.decryptFrom(bob, anaAsPeer, armored);
    expect(decrypted.text).toEqual('oi, sou a ana');
    expect(decrypted.verified).toBeFalse();
  });

  it('formata a impressão digital em blocos legíveis', () => {
    expect(pgp.formatFingerprint('abcd1234ef')).toEqual('ABCD 1234 EF');
  });
});
