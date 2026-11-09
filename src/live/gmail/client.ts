/**
 * Minimal Gmail REST client (users.messages / users.threads). The sign-in is not
 * done here: the gateway hands this process a client id, client secret and
 * refresh token in the environment (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN —
 * the same variables the gateway already maps for Gmail). This client only turns
 * the refresh token into short-lived access tokens, in memory. Nothing secret is
 * ever written to a log or an error message.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailHeader { name: string; value: string }
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
  raw?: string;
}

/** Gmail refuses too many parallel or too many per-minute reads; waiting and asking again is what it asks for. */
const READ_WAITS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const MAX_WAIT_MS = 30_000;

function isRateLimited(status: number, text: string): boolean {
  return status === 429 || (status === 403 && /rate.?limit|quota exceeded|too many/i.test(text));
}

/** Run `fn` over `items`, at most `limit` at a time; results keep the order of `items`. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class GmailClient {
  private accessToken: string | null = null;
  private expiresAt = 0;

  constructor(
    private readonly creds: { clientId: string; clientSecret: string; refreshToken: string },
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): GmailClient {
    const clientId = env.CLIENT_ID?.trim();
    const clientSecret = env.CLIENT_SECRET?.trim();
    const refreshToken = env.REFRESH_TOKEN?.trim();
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        "Refused: the Gmail adapter has no Google sign-in (CLIENT_ID, CLIENT_SECRET and REFRESH_TOKEN are required). " +
          "Nothing was read or changed. Sign in to Google in the gateway, or set EMAIL_MODE=simulation.",
      );
    }
    return new GmailClient({ clientId, clientSecret, refreshToken }, fetchImpl);
  }

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        refresh_token: this.creds.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) {
      throw new Error(`Google sign-in failed (${res.status}): ${json.error ?? "unknown error"}${json.error_description ? ` — ${json.error_description}` : ""}. Sign in to Google again in the gateway.`);
    }
    this.accessToken = json.access_token;
    this.expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  private async request<T>(method: string, path: string, query?: Record<string, string | string[]>, body?: unknown): Promise<T> {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
    }
    // Only reads are asked again: a send is never repeated.
    let res: Response;
    let text: string;
    for (let attempt = 0; ; attempt += 1) {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      text = await res.text();
      if (method !== "GET" || attempt >= READ_WAITS_MS.length || !isRateLimited(res.status, text)) break;
      const asked = Number(res.headers.get("retry-after")) * 1000;
      await this.sleep(Math.min(asked > 0 ? asked : READ_WAITS_MS[attempt], MAX_WAIT_MS));
    }
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try { msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* keep raw */ }
      throw new Error(`Gmail ${method} ${path} failed (${res.status}): ${msg}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  getProfile(): Promise<{ emailAddress: string }> {
    return this.request("GET", "/profile");
  }

  listIds(labelId: string, limit: number, q?: string): Promise<{ messages?: { id: string; threadId: string }[] }> {
    return this.request("GET", "/messages", { labelIds: labelId, maxResults: String(limit), ...(q ? { q } : {}) });
  }

  getMetadata(id: string, headers: string[]): Promise<GmailMessage> {
    return this.request("GET", `/messages/${encodeURIComponent(id)}`, { format: "metadata", metadataHeaders: headers });
  }

  getFull(id: string): Promise<GmailMessage> {
    return this.request("GET", `/messages/${encodeURIComponent(id)}`, { format: "full" });
  }

  getRaw(id: string): Promise<GmailMessage> {
    return this.request("GET", `/messages/${encodeURIComponent(id)}`, { format: "raw" });
  }

  getThreadMetadata(threadId: string, headers: string[]): Promise<{ messages?: GmailMessage[] }> {
    return this.request("GET", `/threads/${encodeURIComponent(threadId)}`, { format: "metadata", metadataHeaders: headers });
  }

  async getAttachmentData(messageId: string, attachmentId: string): Promise<Buffer> {
    const r = await this.request<{ data?: string }>("GET", `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
    return Buffer.from(r.data ?? "", "base64url");
  }

  send(raw: string, threadId?: string): Promise<{ id: string; threadId: string }> {
    return this.request("POST", "/messages/send", undefined, {
      raw: Buffer.from(raw, "utf8").toString("base64url"),
      ...(threadId ? { threadId } : {}),
    });
  }

  /** Not an agent tool — used by the live contract test to clean up. */
  trash(id: string): Promise<unknown> {
    return this.request("POST", `/messages/${encodeURIComponent(id)}/trash`);
  }
}

export function header(headers: GmailHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}
