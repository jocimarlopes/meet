import { Injectable } from '@angular/core';
import {
  createMessage,
  decrypt,
  encrypt,
  generateKey,
  readKey,
  readMessage,
  type PrivateKey,
  type PublicKey,
} from 'openpgp';

/** Par de chaves efêmero, gerado no navegador e nunca enviado a lugar nenhum. */
export interface Identity {
  nick: string;
  privateKey: PrivateKey;
  publicKey: PublicKey;
  publicKeyArmored: string;
  fingerprint: string;
}

/** Chave pública do outro lado, já validada localmente. */
export interface PeerIdentity {
  nick: string;
  publicKey: PublicKey;
  fingerprint: string;
}

export interface DecryptedMessage {
  text: string;
  /** Assinatura conferida contra a chave pública do peer. */
  verified: boolean;
}

/**
 * Cifragem ponta a ponta com OpenPGP.
 *
 * Cada sessão gera um par de chaves novo (Curve25519, formato v4 para manter
 * compatibilidade com outras implementações PGP). A chave privada vive só na
 * memória da aba: fechou, acabou.
 */
@Injectable({ providedIn: 'root' })
export class PgpService {
  async generateIdentity(nick: string): Promise<Identity> {
    const { privateKey, publicKey } = await generateKey({
      type: 'ecc',
      curve: 'curve25519Legacy',
      userIDs: [{ name: nick }],
      format: 'object',
    });

    return {
      nick,
      privateKey,
      publicKey,
      publicKeyArmored: publicKey.armor(),
      fingerprint: publicKey.getFingerprint(),
    };
  }

  /**
   * Importa a chave pública recebida via signaling.
   *
   * A impressão digital é sempre recalculada a partir da chave, nunca aceita
   * pronta do servidor — é ela que o usuário compara por fora para detectar um
   * servidor de signaling malicioso trocando chaves no meio do caminho.
   */
  async importPeerKey(nick: string, armored: string): Promise<PeerIdentity> {
    const publicKey = await readKey({ armoredKey: armored });
    return { nick, publicKey, fingerprint: publicKey.getFingerprint() };
  }

  /** Cifra para o peer e assina com a própria chave. */
  async encryptFor(
    identity: Identity,
    peer: PeerIdentity,
    text: string,
  ): Promise<string> {
    return (await encrypt({
      message: await createMessage({ text }),
      encryptionKeys: peer.publicKey,
      signingKeys: identity.privateKey,
      format: 'armored',
    })) as string;
  }

  /** Decifra e confere a assinatura do peer. */
  async decryptFrom(
    identity: Identity,
    peer: PeerIdentity,
    armored: string,
  ): Promise<DecryptedMessage> {
    const { data, signatures } = await decrypt({
      message: await readMessage({ armoredMessage: armored }),
      decryptionKeys: identity.privateKey,
      verificationKeys: peer.publicKey,
      format: 'utf8',
    });

    // `verified` é uma promise que rejeita quando a assinatura não bate; uma
    // mensagem legível mas não autenticada continua sendo exibida, marcada.
    let verified = false;
    try {
      verified = signatures.length > 0 && (await signatures[0].verified);
    } catch {
      verified = false;
    }

    return { text: data as string, verified };
  }

  /** Agrupa a impressão digital em blocos de 4 para leitura em voz alta. */
  formatFingerprint(fingerprint: string): string {
    return (fingerprint.match(/.{1,4}/g) ?? []).join(' ').toUpperCase();
  }
}
