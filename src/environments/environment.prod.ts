// Produção: front no GitHub Pages, signaling na Vercel.
// Troque o host abaixo pelo domínio do seu projeto na Vercel.

const SIGNALING_HOST = 'chat-p2p-signaling.vercel.app';

export const environment = {
  production: true,
  apiUrl: `https://${SIGNALING_HOST}/api`,
  signalingUrl: `wss://${SIGNALING_HOST}/api/ws`,

  // Sem TURN, conexões atrás de NAT simétrico não fecham. Se for o seu caso,
  // acrescente aqui um servidor TURN com credenciais.
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ] as RTCIceServer[],
};
