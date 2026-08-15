import { Injectable } from '@angular/core';

/**
 * Numa malha, cada imagem sobe uma vez **por participante**: numa sala de 10,
 * mandar 3 MB significa 27 MB saindo da sua conexão. Por isso a imagem é
 * reduzida antes de sair, em vez de confiar no arquivo original.
 */
const MAX_LARGURA = 1024;
const MAX_ALTURA = 768;
const QUALIDADE = 0.82;
/** Já cabe na caixa e é leve: reprocessar só perderia qualidade (e a
    transparência de um PNG, que vira JPEG no canvas). */
const PEQUENA_ATE = 200 * 1024;
/** Teto do que sai no fio, já em base64. Acima disso a malha sofre. */
export const MAX_BASE64_BYTES = 2 * 1024 * 1024;

export interface PreparedImage {
  mime: string;
  name: string;
  /** Base64 puro, sem o prefixo `data:`. */
  data: string;
}

@Injectable({ providedIn: 'root' })
export class ImageService {
  /**
   * Prepara o arquivo para caber no chat: reduz quando grande, converte para
   * JPEG e devolve em base64 pronto para entrar no bloco PGP.
   */
  async prepare(file: File): Promise<PreparedImage> {
    if (!file.type.startsWith('image/')) {
      throw new Error('Só dá para enviar imagem.');
    }

    const original = await this.toDataUrl(file);
    const img = await this.carregar(original);
    const cabe = img.width <= MAX_LARGURA && img.height <= MAX_ALTURA;

    // GIF perde a animação ao passar pelo canvas, então sai como veio mesmo
    // grande. O resto só escapa da redução se já couber na caixa e for leve.
    const preservar = file.type === 'image/gif' || (cabe && file.size <= PEQUENA_ATE);
    const dataUrl = preservar ? original : this.reduzir(img);

    const virgula = dataUrl.indexOf(',');
    const data = dataUrl.slice(virgula + 1);
    const mime = preservar ? file.type : 'image/jpeg';

    if (data.length > MAX_BASE64_BYTES) {
      throw new Error('Imagem grande demais mesmo depois de reduzida.');
    }

    return { mime, name: file.name || 'imagem', data };
  }

  /** Monta a URL que a tela usa para exibir o que chegou. */
  toObjectUrl(mime: string, base64: string): string {
    const binario = atob(base64);
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i += 1) {
      bytes[i] = binario.charCodeAt(i);
    }
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  }

  private toDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
      reader.readAsDataURL(file);
    });
  }

  /**
   * Encaixa na caixa de 1024x768 mantendo a proporção — nunca amplia. Retrato
   * fica limitado pela altura, paisagem pela largura.
   */
  private reduzir(img: HTMLImageElement): string {
    const escala = Math.min(MAX_LARGURA / img.width, MAX_ALTURA / img.height, 1);

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * escala);
    canvas.height = Math.round(img.height * escala);

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return img.src;
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', QUALIDADE);
  }

  private carregar(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Arquivo de imagem inválido.'));
      img.src = src;
    });
  }
}
