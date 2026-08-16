import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';

/**
 * Salvar a imagem — a única saída autorizada do aplicativo.
 *
 * Na web, `<a download>` resolve. Na WebView do Android **não**: não existe
 * gerenciador de download ali, e o clique simplesmente não faz nada. Por isso
 * o caminho nativo grava o arquivo pelo Filesystem.
 *
 * Grava em Documents em vez de abrir a folha de compartilhamento de propósito:
 * a folha seria uma saída larga, para qualquer aplicativo, e contradiz a ideia
 * de nada sair daqui. Aqui sai um arquivo, para um lugar previsível.
 */
@Injectable({ providedIn: 'root' })
export class DownloadService {
  get isNative(): boolean {
    return Capacitor.isNativePlatform();
  }

  /** Devolve onde o arquivo ficou, quando isso faz sentido para o usuário. */
  async save(url: string, name: string): Promise<string | null> {
    if (!this.isNative) {
      this.saveViaAnchor(url, name);
      return null;
    }

    const blob = await (await fetch(url)).blob();
    const base64 = await this.toBase64(blob);
    const { uri } = await Filesystem.writeFile({
      path: name,
      data: base64,
      directory: Directory.Documents,
      recursive: true,
    });
    return uri;
  }

  private saveViaAnchor(url: string, name: string): void {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
  }

  /** O Filesystem só aceita base64; o `data:` do FileReader traz um prefixo. */
  private toBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const resultado = reader.result as string;
        resolve(resultado.slice(resultado.indexOf(',') + 1));
      };
      reader.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
      reader.readAsDataURL(blob);
    });
  }
}
