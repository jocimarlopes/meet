/**
 * O que vai dentro do bloco PGP.
 *
 * Antes era o texto puro. Com imagem no chat é preciso dizer o que se está
 * mandando, e essa informação tem que ficar **dentro** da parte cifrada: se o
 * tipo e o nome do arquivo viajassem do lado de fora, qualquer um no caminho
 * saberia que você mandou `raio-x.jpg` sem precisar abrir nada.
 */
export type ChatPayload =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mime: string; name: string; data: string }
  // Legenda do que a pessoa está falando, reconhecida no aparelho dela. Vai
  // pelo mesmo bloco cifrado do resto: é fala transcrita, não metadado.
  | { kind: 'caption'; text: string; final: boolean };

/** Marca o formato para o outro lado não adivinhar. */
const MARKER = 'meetp2p/1';

export function encodePayload(payload: ChatPayload): string {
  return JSON.stringify({ v: MARKER, ...payload });
}

/**
 * Decodifica com tolerância: o que não for reconhecido volta como texto puro,
 * porque exibir a mensagem crua é melhor do que engolir a conversa por causa
 * de um formato inesperado.
 */
export function decodePayload(raw: string): ChatPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'text', text: raw };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'text', text: raw };
  }

  const objeto = parsed as Record<string, unknown>;
  if (objeto['v'] !== MARKER) {
    return { kind: 'text', text: raw };
  }

  if (
    objeto['kind'] === 'image' &&
    typeof objeto['data'] === 'string' &&
    typeof objeto['mime'] === 'string'
  ) {
    return {
      kind: 'image',
      mime: objeto['mime'],
      name: typeof objeto['name'] === 'string' ? objeto['name'] : 'imagem',
      data: objeto['data'],
    };
  }

  if (objeto['kind'] === 'caption' && typeof objeto['text'] === 'string') {
    return { kind: 'caption', text: objeto['text'], final: objeto['final'] === true };
  }

  if (objeto['kind'] === 'text' && typeof objeto['text'] === 'string') {
    return { kind: 'text', text: objeto['text'] };
  }

  return { kind: 'text', text: raw };
}
