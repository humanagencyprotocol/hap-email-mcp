/**
 * The proof of the email-adapter contract against a real Gmail account: send a
 * reply in a thread through the adapter, read the raw message back from Gmail
 * (users.messages.get format=raw), assert the contract, then trash it.
 *
 * Skipped unless the Google test account is available. The credentials are read
 * inside this helper only (env GMAIL_TEST_{CLIENT_ID,CLIENT_SECRET,REFRESH_TOKEN},
 * or the "google" entry of ~/.suveren-test-accounts.json) and are never printed
 * or logged.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { GmailClient } from "../src/live/gmail/client.js";
import { callGmailTool, decodeWords } from "../src/live/gmail/dispatch.js";
import { parseRaw, getHeader, decodeBody } from "./helpers/raw.js";

function credentials(): { CLIENT_ID: string; CLIENT_SECRET: string; REFRESH_TOKEN: string } | null {
  const e = process.env;
  if (e.GMAIL_TEST_CLIENT_ID && e.GMAIL_TEST_CLIENT_SECRET && e.GMAIL_TEST_REFRESH_TOKEN) {
    return { CLIENT_ID: e.GMAIL_TEST_CLIENT_ID, CLIENT_SECRET: e.GMAIL_TEST_CLIENT_SECRET, REFRESH_TOKEN: e.GMAIL_TEST_REFRESH_TOKEN };
  }
  try {
    const g = JSON.parse(readFileSync(join(homedir(), ".suveren-test-accounts.json"), "utf8")).google;
    if (g?.clientId && g?.clientSecret && g?.refreshToken) return { CLIENT_ID: g.clientId, CLIENT_SECRET: g.clientSecret, REFRESH_TOKEN: g.refreshToken };
  } catch { /* no file: skip */ }
  return null;
}

const creds = credentials();

describe.skipIf(!creds)("Gmail adapter against the real test account", () => {
  it("a large list does not run into Gmail's limit on parallel reads", async () => {
    const env = { ...creds! } as NodeJS.ProcessEnv;
    const list = (await callGmailTool("list_messages", { folder: "inbox", limit: 500 }, env, GmailClient.fromEnv(env))) as unknown[];
    expect(Array.isArray(list)).toBe(true);
    console.log(`listed ${list.length} messages`);
  }, 180_000);

  it("a reply in a thread contains exactly the bound fields", async () => {
    const env = { ...creds! } as NodeJS.ProcessEnv;
    const client = GmailClient.fromEnv(env);
    const me = (await client.getProfile()).emailAddress;
    const stamp = `contract-${Date.now()}`;
    const trash: string[] = [];
    try {
      // 1. a first mail to the account itself (it lands in the inbox, so there is a thread to reply in)
      const first = (await callGmailTool("send_message", {
        to: [me], subject: `Contract test ${stamp}`, body: `First message ${stamp}`,
      }, env, client)) as any;
      trash.push(first.id);
      expect(first.subject).toBe(`Contract test ${stamp}`);
      expect(first.body).toBe(`First message ${stamp}`);

      // 2. the reply: subject exactly as bound (the AI chose "Re: ..." itself), body with the gateway footer, a non-ASCII word
      const subject = `Re: Contract test ${stamp}`;
      const body = `Thanks — Grüße ${stamp}.\n\nA second paragraph.\n\n-- \nSent by an AI on behalf of the account owner`;
      const reply = (await callGmailTool("send_message", {
        to: [me], subject, body, in_reply_to: first.id,
      }, env, client)) as any;
      trash.push(reply.id);

      // 3. same output shape as the simulation, and the reply is linked to the first message
      expect(Object.keys(reply).sort()).toEqual(["attachments", "body", "cc", "folder", "from", "id", "in_reply_to", "received_at", "subject", "to"]);
      expect(reply.in_reply_to).toBe(first.id);

      // 4. the raw message, read back from Gmail
      const rawMsg = await client.getRaw(reply.id);
      const raw = Buffer.from(rawMsg.raw!, "base64url").toString("utf8");
      const p = parseRaw(raw);
      const firstRaw = parseRaw(Buffer.from((await client.getRaw(first.id)).raw!, "base64url").toString("utf8"));
      const firstMsgId = getHeader(firstRaw, "Message-ID")!;

      expect(decodeWords(getHeader(p, "Subject")!)).toBe(subject);
      expect(getHeader(p, "To")).toContain(me);
      expect(getHeader(p, "Cc")).toBeUndefined();
      expect(getHeader(p, "In-Reply-To")).toBe(firstMsgId);
      expect(getHeader(p, "References")!.split(" ").pop()).toBe(firstMsgId);
      expect(getHeader(p, "References")).toMatch(/^(<[^<>\s]+> ?)+$/);
      expect(rawMsg.threadId).toBe((await client.getFull(first.id)).threadId);

      expect(p.rawHeaderBlock).not.toMatch(/[^?]=\r\n/); // no QP soft breaks in any header
      for (const line of p.rawHeaderBlock.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);

      expect(decodeBody(p)).toBe(body); // exactly the bound text: no quote, no "wrote:"
      expect(raw).not.toMatch(/wrote:/);
      expect(raw).not.toMatch(/^>/m);
      expect(getHeader(p, "Content-Type")).toMatch(/^text\/plain/i); // no HTML alternative carrying a quote

      // 5. the read side shows the same thing
      const got = (await callGmailTool("get_message", { id: reply.id }, env, client)) as any;
      expect(got.subject).toBe(subject);
      expect(got.body).toBe(body);

      const sentList = (await callGmailTool("list_messages", { folder: "sent", limit: 10 }, env, client)) as any[];
      const entry = sentList.find((m) => m.id === reply.id)!;
      expect(Object.keys(entry).sort()).toEqual(["folder", "from", "id", "received_at", "snippet", "subject", "to"]);
      expect(entry.subject).toBe(subject);

      // 5b. the read window: received_after at the message's own time keeps it, one second later drops it
      const atIt = (await callGmailTool("list_messages", { folder: "sent", limit: 10, received_after: entry.received_at }, env, client)) as any[];
      expect(atIt.map((m) => m.id)).toContain(reply.id);
      const later = new Date(Date.parse(entry.received_at) + 1000).toISOString();
      const pastIt = (await callGmailTool("list_messages", { folder: "sent", limit: 10, received_after: later }, env, client)) as any[];
      expect(pastIt.map((m) => m.id)).not.toContain(reply.id);

      console.log("[live contract] headers on the sent message:", p.headers.map((h) => h.name).join(", "));
      console.log("[live contract] OK: subject, to, in-reply-to, references, body exact; same thread; no quote");
    } finally {
      for (const id of trash) await client.trash(id).catch(() => undefined);
    }
  }, 60_000);

  it("an attachment goes out unchanged and comes back through get_attachment", async () => {
    const env = { ...creds! } as NodeJS.ProcessEnv;
    const client = GmailClient.fromEnv(env);
    const me = (await client.getProfile()).emailAddress;
    const bytes = Buffer.from(`attachment bytes ${Date.now()} \u00e4\u00f6`, "utf8");
    let id: string | undefined;
    try {
      const sent = (await callGmailTool("send_message", {
        to: [me], subject: `Attachment contract ${Date.now()}`, body: "See attached.",
        attachments: [{ filename: "Rechnung März.txt", contentType: "text/plain", contentBase64: bytes.toString("base64") }],
      }, env, client)) as any;
      id = sent.id;
      expect(sent.body).toBe("See attached.");
      expect(sent.attachments).toHaveLength(1);
      expect(sent.attachments[0].filename).toBe("Rechnung März.txt");
      expect(sent.attachments[0].size).toBe(bytes.length);
      const got = (await callGmailTool("get_attachment", { message_id: sent.id, index: 0 }, env, client)) as any;
      expect(Buffer.from(got.contentBase64, "base64").equals(bytes)).toBe(true);
      const bySha = (await callGmailTool("get_attachment", { message_id: sent.id, sha256: sent.attachments[0].sha256 }, env, client)) as any;
      expect(bySha.contentBase64).toBe(got.contentBase64);
    } finally {
      if (id) await client.trash(id).catch(() => undefined);
    }
  }, 60_000);

  it("simulation-only tools stay refused in live mode", async () => {
    const env = { ...creds! } as NodeJS.ProcessEnv;
    await expect(callGmailTool("load_simulation", { package: {} }, env, GmailClient.fromEnv(env))).rejects.toThrow(/not available in live mode/);
    await expect(callGmailTool("clear_simulation", {}, env, GmailClient.fromEnv(env))).rejects.toThrow(/not available in live mode/);
  });
});
