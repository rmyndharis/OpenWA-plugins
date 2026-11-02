import { createHash } from 'node:crypto';

export interface Config {
  baseUrl: string;
  sessionId: string;
  department: string;
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
  // This one static Docker origin is explicitly declared in the manifest. Other origins need HTTPS.
  if (url.protocol !== 'https:' && url.origin !== 'http://rocketchat:3000') {
    throw new Error('baseUrl requires HTTPS (except the documented Docker laboratory origin)');
  }
  if (url.hostname.includes('*')) throw new Error('baseUrl cannot contain wildcards');
  if (typeof raw.sessionId !== 'string' || !raw.sessionId.trim() || raw.sessionId.length > 100) {
    throw new Error('sessionId is required');
  }
  if (raw.department !== undefined && (typeof raw.department !== 'string' || raw.department.length > 200)) {
    throw new Error('department must be a string of at most 200 characters');
  }
  return { baseUrl: url.origin, sessionId: raw.sessionId.trim(), department: String(raw.department ?? '').trim() };
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stateKey(config: Config): string {
  return `rocket-v1:${digest(JSON.stringify([config.baseUrl, config.department, config.sessionId]))}`;
}
