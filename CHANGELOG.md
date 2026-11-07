# Changelog

## 0.5.0

New live adapter: `EMAIL_MODE=live` with `EMAIL_LIVE_ADAPTER=gmail` reads and
sends through a Gmail account (Gmail REST API). The Google sign-in arrives in
the environment as `CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN`. Same tools and
output shapes as the simulation; `load_simulation` / `clear_simulation` are
refused. Contract: `send_message` sends exactly `to`, `cc`, `subject`, `body`
and the attachments it was given. No "Re:" is added, no quote of the earlier
message. A reply (`in_reply_to` = the Gmail id of the message answered) stays in
its thread with correct `In-Reply-To` / `References`; headers are folded at
whitespace, never with quoted-printable soft breaks. Checked by
`test/gmail-contract.test.ts` (pure) and `test/gmail-live.test.ts` (real
account, skipped without credentials). Without `EMAIL_LIVE_ADAPTER`, `live`
still refuses every call.

`send_message` accepts an optional `attachments` argument
(`[{ filename, contentType, contentBase64 }]`, max 10 files / 10 MB each /
25 MB total) — the agent refers to a document, the governing gateway supplies
the bytes. New `attachments` table (SQLite + Postgres). `get_message` returns
attachment metadata only (filename, contentType, size, sha256); new
`get_attachment({ message_id, sha256 | index })` tool returns file content.
Inbound simulated messages do not carry attachments — the shared simulation
package schema was left unchanged. `send_message` without `attachments` is
unchanged.

## 0.3.0

**BREAKING:** the tool argument `receipt_id` is now `ticket_id` (HAP v0.7
vocabulary); the Suveren gateway fills it — use gateway v0.7 or later.

This is a breaking change on the wire, released as a minor by the owner's
decision (pre-1.0, one implementation). Internal SQLite storage is unaffected:
the `receipt_id` column name on the `messages`, `changes`, and `refusals`
tables is unchanged — it now stores the value supplied under the `ticket_id`
argument.
