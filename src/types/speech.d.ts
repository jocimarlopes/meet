/**
 * Tipos da Web Speech API com reconhecimento local.
 *
 * O `lib.dom` do TypeScript ainda não descreve `processLocally`, `available()`
 * nem `install()` — que são exatamente o que este projeto precisa para não
 * mandar áudio para fora.
 */
interface SpeechRecognitionAvailabilityOptions {
  langs: string[];
  processLocally?: boolean;
}

type SpeechRecognitionAvailability =
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}

declare const SpeechRecognition: {
  new (): SpeechRecognition;
  available(options: SpeechRecognitionAvailabilityOptions): Promise<SpeechRecognitionAvailability>;
  install(options: SpeechRecognitionAvailabilityOptions): Promise<boolean>;
};
