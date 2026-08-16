import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Empacotamento nativo.
 *
 * O motivo de existir: na web, quem controla a hospedagem serve um JavaScript
 * alterado e lê tudo antes de qualquer cifra. Aqui os arquivos vão **dentro do
 * APK assinado**, entregues uma vez e verificados pelo sistema.
 */
const config: CapacitorConfig = {
  appId: 'com.jolosystems.jolomeet',
  appName: 'Jolo Meet',
  // Mesmo `outputPath` que o Angular já usa.
  webDir: 'www',
  android: {
    // A origem dentro do app vira `https://localhost`: contexto seguro, que é
    // o que libera `getUserMedia`. Com `http` a câmera e o microfone morrem.
    androidScheme: 'https',
  },
  ios: {
    scheme: 'Jolo Meet',
  },
  // Sem `server.allowNavigation` de propósito: nada remoto entra na WebView.
  // Link externo abre no navegador do sistema, fora do app.
};

export default config;
