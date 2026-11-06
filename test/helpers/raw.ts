/** Test helper: parse a raw RFC 822 message just enough to assert the contract. */
export interface ParsedRaw {
  /** Header lines as written, in order, before unfolding. */
  rawHeaderBlock: string;
  /** Unfolded headers, in order. Names keep their case. */
  headers: { name: string; value: string }[];
  /** Body after the blank line, exactly as written. */
  rawBody: string;
}

export function parseRaw(raw: string): ParsedRaw {
  const sep = raw.indexOf("\r\n\r\n");
  if (sep < 0) throw new Error("no header/body separator");
  const rawHeaderBlock = raw.slice(0, sep);
  const unfolded = rawHeaderBlock.replace(/\r\n(?=[ \t])/g, "");
  const headers = unfolded.split("\r\n").map((l) => {
    const i = l.indexOf(":");
    return { name: l.slice(0, i), value: l.slice(i + 1).replace(/^ /, "") };
  });
  return { rawHeaderBlock, headers, rawBody: raw.slice(sep + 4) };
}

export function getHeader(p: ParsedRaw, name: string): string | undefined {
  return p.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/** Decodes the text/plain body of a single-part base64 / 7bit / 8bit / quoted-printable message. */
export function decodeBody(p: ParsedRaw): string {
  const cte = (getHeader(p, "Content-Transfer-Encoding") ?? "7bit").toLowerCase();
  if (cte === "base64") return Buffer.from(p.rawBody.replace(/\s+/g, ""), "base64").toString("utf8");
  if (cte === "quoted-printable") {
    return Buffer.from(
      p.rawBody.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))),
      "latin1",
    ).toString("utf8");
  }
  return p.rawBody;
}
