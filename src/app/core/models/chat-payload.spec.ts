import { decodePayload, encodePayload } from './chat-payload';

describe('chat payload', () => {
  it('leva texto e imagem de ida e volta', () => {
    expect(decodePayload(encodePayload({ kind: 'text', text: 'oi' }))).toEqual({
      kind: 'text',
      text: 'oi',
    });

    const imagem = {
      kind: 'image' as const,
      mime: 'image/jpeg',
      name: 'foto.jpg',
      data: 'AAAA',
    };
    expect(decodePayload(encodePayload(imagem))).toEqual(imagem);
  });

  it('o tipo e o nome do arquivo ficam dentro da parte cifrada', () => {
    // Se viajassem fora, quem estivesse no caminho saberia o que foi enviado
    // sem precisar abrir nada. O que sai daqui é o que será cifrado.
    const codificado = encodePayload({
      kind: 'image',
      mime: 'image/png',
      name: 'raio-x.png',
      data: 'AAAA',
    });
    expect(codificado).toContain('raio-x.png');
    expect(codificado).toContain('image/png');
  });

  it('trata como texto o que não reconhece', () => {
    // Mensagem de uma versão diferente do app, ou alguém digitando JSON:
    // exibir cru é melhor do que engolir a conversa.
    for (const cru of ['oi tudo bem', '{"kind":"image"}', '{sem fechar', '']) {
      expect(decodePayload(cru)).toEqual({ kind: 'text', text: cru });
    }
  });

  it('texto que parece JSON sobrevive à ida e volta', () => {
    const armadilha = '{"v":"meetp2p/1","kind":"image","data":"nao sou imagem"}';
    expect(decodePayload(encodePayload({ kind: 'text', text: armadilha }))).toEqual({
      kind: 'text',
      text: armadilha,
    });
  });
});
