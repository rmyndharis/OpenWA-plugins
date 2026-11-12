import { createHash } from 'node:crypto';

export interface Config {
  baseUrl: string;
  sessionId: string;
  department: string;
  deadLetterAction?: 'none' | 'replay' | 'clear';
  deadLetterActionId?: string;
}

export function readConfig(raw: Record<string, unknown>): Config {
  if (typeof raw.baseUrl !== 'string') throw new Error('baseUrl is required');
  let url: URL;
  try {
    url = new URL(raw.baseUrl);
  } catch {
    throw new Error('baseUrl must be an origin URL');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('baseUrl must be an origin without credentials, path, query or fragment');
  }
  if (url.protocol !== 'https:') throw new Error('baseUrl requires HTTPS');
  if (url.hostname.includes('*')) throw new Error('baseUrl cannot contain wildcards');
  if (typeof raw.sessionId !== 'string' || !raw.sessionId.trim() || raw.sessionId.length > 100) {
    throw new Error('sessionId is required');
  }
  if (raw.department !== undefined && (typeof raw.department !== 'string' || raw.department.length > 200)) {
    throw new Error('department must be a string of at most 200 characters');
  }
  const action = raw.deadLetterAction ?? 'none';
  if (action !== 'none' && action !== 'replay' && action !== 'clear') throw new Error('Invalid deadLetterAction');
  const requestId = raw.deadLetterActionId;
  if (
    requestId !== undefined &&
    requestId !== '' &&
    (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId))
  ) {
    throw new Error('deadLetterActionId must contain 1-100 letters, digits, hyphens or underscores');
  }
  if (action !== 'none' && !requestId) throw new Error('A unique deadLetterActionId is required for maintenance');
  return {
    baseUrl: url.origin,
    sessionId: raw.sessionId.trim(),
    department: String(raw.department ?? '').trim(),
    deadLetterAction: action,
    deadLetterActionId: requestId as string | undefined,
  };
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stateKey(config: Config): string {
  return `rocket-v1:${digest(JSON.stringify([config.baseUrl, config.department, config.sessionId]))}`;
}
