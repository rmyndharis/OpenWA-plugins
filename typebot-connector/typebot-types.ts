// Pure shared types for typebot-connector. No runtime code — safe to import from any module.

export interface TypebotConfig {
  apiHost: string;            // normalized: https, no trailing slash
  publicId: string;
  apiToken?: string;          // only for restricted/preview bots
  respondInGroups: boolean;
  sessionTimeoutMinutes: number;
  passContactVariables: boolean;
}

// ── Normalized Typebot Chat API response ──────────────────────────────────────────────
export interface ChoiceItem {
  id: string;
  content: string;            // the label shown to the user AND the value sent back to continueChat
}

export type Bubble =
  | { kind: 'text'; markdown: string }
  | { kind: 'image' | 'video' | 'audio'; url: string }
  | { kind: 'link'; url: string };          // embed/custom-embed/non-sendable video → sent as a URL

export type InputSpec =
  | { kind: 'choice'; blockId: string; items: ChoiceItem[]; multiple: boolean }
  | { kind: 'rating'; blockId: string; max?: number }
  | { kind: 'file'; blockId: string }
  | { kind: 'text'; blockId: string; placeholder?: string; attachmentsEnabled: boolean }
  | { kind: 'unsupported'; blockId: string; typeLabel: string };

export interface NormalizedResponse {
  sessionId?: string;         // present only from startChat
  bubbles: Bubble[];
  input?: InputSpec;          // absent ⇒ flow ended
  redirectUrl?: string;       // from a clientSideActions redirect
}

// ── Persisted per-key session state ───────────────────────────────────────────────────
export type Awaiting = InputSpec;
export interface SessionState {
  sessionId: string;
  awaiting: Awaiting;
  lastActivity: number;       // epoch ms
}

// ── render output (turn.ts fills in sessionId/chatId/replyTo) ──────────────────────────
export type OutgoingPart =
  | { type: 'text'; text: string }
  | { type: 'image' | 'video' | 'audio'; mediaUrl: string };

// ── reply-map output ──────────────────────────────────────────────────────────────────
export type ReplyIntent =
  | { kind: 'text'; message: string }                                   // send as the continueChat message string
  | { kind: 'file'; mime: string; filename: string; data: string }      // base64 data → upload, then continueChat
  | { kind: 'fallback'; text: string };                                 // send this text to WA and DO NOT advance
