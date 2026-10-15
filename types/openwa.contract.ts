import type { ChatSummary, IncomingMessage, PluginManifest } from './openwa';

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

type VersionFloor = Assert<Equal<PluginManifest['minOpenWAVersion'], string | null | undefined>>;
type Poll = Assert<Equal<IncomingMessage['poll'], {
  name: string;
  options: string[];
  allowMultipleAnswers: boolean;
} | undefined>>;
type LastMessageType = Assert<Equal<ChatSummary['lastMessageType'], string | undefined>>;
