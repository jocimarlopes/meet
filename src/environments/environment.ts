// Desenvolvimento: backend rodando local (uvicorn na 8000).
// `ng build` troca este arquivo por environment.prod.ts (ver angular.json).

export const environment = {
  production: false,
  // Vazio no desenvolvimento: cai no `document.baseURI`, que é a própria
  // página servida pelo `ng serve`.
  inviteBaseUrl: '',
  apiUrl: 'http://localhost:8000/api',
  signalingUrl: 'ws://localhost:8000/api/ws',

  // STUN resolve a maioria dos casos. Atrás de NAT simétrico (algumas redes
  // corporativas e móveis) a conexão direta falha e só um TURN resolve —
  // adicione o seu aqui com `username` e `credential`.
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ] as RTCIceServer[],
};
