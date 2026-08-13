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
    const armored = await pgp.encryptFor(ana, [bobAsPeer], text);

    expect(armored).toContain('BEGIN PGP MESSAGE');
    expect(armored).not.toContain('segredo');

    const decrypted = await pgp.decryptFrom(bob, anaAsPeer, armored);
    expect(decrypted.text).toEqual(text);
    expect(decrypted.verified).toBeTrue();
  });

  it('um bloco só atende a sala inteira', async () => {
    const carol = await pgp.generateIdentity('carol');
    const carolAsPeer = await pgp.importPeerKey('carol', carol.publicKeyArmored);

    // A mesma mensagem cifrada para os dois: cada um abre com a sua chave.
    const armored = await pgp.encryptFor(ana, [bobAsPeer, carolAsPeer], 'oi turma');

    for (const recipient of [bob, carol]) {
      const decrypted = await pgp.decryptFrom(recipient, anaAsPeer, armored);
      expect(decrypted.text).toEqual('oi turma');
      expect(decrypted.verified).toBeTrue();
    }
  });

  it('quem não está entre os destinatários não abre a mensagem', async () => {
    const forasteiro = await pgp.generateIdentity('forasteiro');
    const armored = await pgp.encryptFor(ana, [bobAsPeer], 'só para o bob');

    await expectAsync(pgp.decryptFrom(forasteiro, anaAsPeer, armored)).toBeRejected();
  });

  it('não decifra mensagem destinada a outra pessoa', async () => {
    const armored = await pgp.encryptFor(ana, [bobAsPeer], 'só para o bob');
    await expectAsync(pgp.decryptFrom(ana, bobAsPeer, armored)).toBeRejected();
  });

  it('marca como não verificada a mensagem assinada por um terceiro', async () => {
    const impostor = await pgp.generateIdentity('impostor');
    const armored = await pgp.encryptFor(impostor, [bobAsPeer], 'oi, sou a ana');

    // Bob decifra achando que veio da Ana: o texto sai, mas sem selo.
    const decrypted = await pgp.decryptFrom(bob, anaAsPeer, armored);
    expect(decrypted.text).toEqual('oi, sou a ana');
    expect(decrypted.verified).toBeFalse();
  });

  it('recusa cifrar sem destinatário', async () => {
    await expectAsync(pgp.encryptFor(ana, [], 'para o vazio')).toBeRejected();
  });

  it('formata a impressão digital em blocos legíveis', () => {
    expect(pgp.formatFingerprint('abcd1234ef')).toEqual('ABCD 1234 EF');
  });
});
