// Produção: front no GitHub Pages, signaling na Vercel.
// Se o projeto da Vercel trocar de domínio, é aqui que se ajusta — e o
// ALLOWED_ORIGINS de lá precisa conter a origem do Pages.

const SIGNALING_HOST = 'chat-p2p-backend-five.vercel.app';

export const environment = {
  production: true,
  // De onde sai o link de convite. Precisa ser fixo porque dentro do APK
  // `document.baseURI` é `https://localhost/` — o link copiado não abriria
  // para mais ninguém.
  inviteBaseUrl: 'https://jocimarlopes.github.io/meet/',
  apiUrl: `https://${SIGNALING_HOST}/api`,
  signalingUrl: `wss://${SIGNALING_HOST}/api/ws`,

  // Sem TURN, conexões atrás de NAT simétrico não fecham. Se for o seu caso,
  // acrescente aqui um servidor TURN com credenciais.
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ] as RTCIceServer[],
};
