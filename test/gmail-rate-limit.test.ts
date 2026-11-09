import { describe, it, expect } from "vitest";
import { GmailClient, mapLimit } from "../src/live/gmail/client.js";

const creds = { clientId: "a", clientSecret: "b", refreshToken: "c" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const client = (answer: (url: string, method: string) => Response, waits: number[] = []) =>
  new GmailClient(creds, (async (u: any, init: any) => {
    const url = String(u);
    if (url.includes("oauth2")) return json({ access_token: "t", expires_in: 3600 });
    return answer(url, init.method);
  }) as typeof fetch, async (ms) => { waits.push(ms); });

describe("reading Gmail politely", () => {
  it("mapLimit never runs more than the limit at once and keeps the order", async () => {
    let now = 0; let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 5, async (n) => {
      now += 1; peak = Math.max(peak, now);
      await new Promise((r) => setTimeout(r, 5 - (n % 5)));
      now -= 1;
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(5);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]);
  });

  it("a read refused with 429 waits and is asked again", async () => {
    const waits: number[] = []; let calls = 0;
    const c = client(() => (++calls < 3 ? json({ error: { message: "Too many concurrent requests for user." } }, 429) : json({ emailAddress: "x@y" })), waits);
    expect((await c.getProfile()).emailAddress).toBe("x@y");
    expect(waits).toEqual([1000, 2000]);
  });

  it("a per-minute quota refusal (403) counts too, and Retry-After is honoured", async () => {
    const waits: number[] = []; let calls = 0;
    const c = client(() => (++calls < 2 ? json({ error: { message: "Quota exceeded for quota metric" } }, 403, { "retry-after": "7" }) : json({ emailAddress: "x@y" })), waits);
    await c.getProfile();
    expect(waits).toEqual([7000]);
  });

  it("gives up visibly after the last wait", async () => {
    const c = client(() => json({ error: { message: "Too many concurrent requests for user." } }, 429));
    await expect(c.getProfile()).rejects.toThrow(/429/);
  });

  it("a real permission refusal (403) is not retried", async () => {
    let calls = 0;
    const c = client(() => { calls += 1; return json({ error: { message: "Insufficient Permission" } }, 403); });
    await expect(c.getProfile()).rejects.toThrow(/403/);
    expect(calls).toBe(1);
  });

  it("a send is never repeated", async () => {
    let calls = 0;
    const c = client(() => { calls += 1; return json({ error: { message: "Too many concurrent requests for user." } }, 429); });
    await expect(c.send("raw")).rejects.toThrow(/429/);
    expect(calls).toBe(1);
  });
});
