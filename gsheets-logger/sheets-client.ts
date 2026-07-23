import { createSign } from 'node:crypto';

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

// The slice of ctx.net.fetch this client needs (host-proxied, SSRF-guarded, gated by the net:fetch
// permission + manifest net.allow). Injectable so tests can fake it. Note the sandbox contract:
// there is NO working res.json()/res.text() — the body comes back as a UTF-8 string in `res.body`.
export type NetFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array },
) => Promise<{ ok: boolean; status: number; body: string }>;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function b64url(input: string): string {
  return Buffer.from(input).toString('base64url');
}

export function buildJwt(sa: ServiceAccount, now: number): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(sa.private_key, 'base64url');
  return `${signingInput}.${signature}`;
}

export class SheetsClient {
  private token: string | null = null;
  private tokenExp = 0; // epoch seconds

  constructor(
    private readonly fetch: NetFetch,
    private readonly sa: ServiceAccount,
    private readonly spreadsheetId: string,
    private readonly sheetTab: string,
  ) {}

  private async getToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && now < this.tokenExp - 60) return this.token;

    const assertion = buildJwt(this.sa, now);
    const res = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: String(new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })),
    });
    if (!res.ok) throw new Error(`Token request failed: ${res.status} ${res.body.slice(0, 300)}`);
    const json = JSON.parse(res.body || '{}') as { access_token?: unknown; expires_in?: unknown };
    if (typeof json.access_token !== 'string' || typeof json.expires_in !== 'number') {
      throw new Error('Token response missing access_token/expires_in');
    }
    this.token = json.access_token;
    this.tokenExp = now + json.expires_in;
    return this.token;
  }

  async appendRows(rows: string[][]): Promise<void> {
    if (rows.length === 0) return;
    const token = await this.getToken();
    const range = encodeURIComponent(`${this.sheetTab}!A1`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}/values/${range}:append`
      + `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ values: rows }),
    });
    if (!res.ok) {
      if (res.status === 401) this.token = null; // force a refresh on the next attempt
      throw new Error(`Append failed: ${res.status} ${res.body.slice(0, 300)}`);
    }
  }
}
