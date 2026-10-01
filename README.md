# HAP Email MCP Server

An email **simulator** for AI agents, built as an [MCP](https://modelcontextprotocol.io)
server and gated through the [Human Agency Protocol](https://humanagencyprotocol.org).

> **@humanagencyp/email-mcp** — unpublished (version 0.1.0, not yet on npm)

---

## What It Does

A simulated inbox the agent reads and replies to. Real (renamed) customer
requests are loaded into the inbox; the agent under test reads them and sends
replies. **Nothing leaves the laptop** — there is no outbound mail transport,
no real mailbox, no network call on `send_message`.

- **`list_messages` / `get_message`** — read the inbox or sent folder
- **`send_message`** — write a reply; it lands in the "sent" folder, nothing
  is actually transmitted
- **`load_simulation`** — create the test inbox from a simulation package,
  once, into an empty database

Every write is gated through the HAP `email` profile
(`hap-profiles/email/0.7.profile.json`).

### Out of scope for 0.1

No drafts, no labels/folders beyond inbox/sent, no attachments, no deleting
messages, no live mailbox adapter.

---

## Quick Start

### Standalone

```bash
npm install
npm run build
node dist/index.js
```

Starts the MCP server with a SQLite database at `~/.hap/email.db` (empty until
`load_simulation` is called).

For Postgres:

```bash
DATABASE_URL=postgres://user:pass@host:5432/mydb node dist/index.js
```

---

## Tools

### Reads

| Tool | Description |
|------|-------------|
| `list_messages` | List messages in a folder (`inbox` default, or `sent`), newest first |
| `get_message` | Get a single message, including its full body |

### Changes

| Tool | Description |
|------|-------------|
| `send_message` | Send a reply (`to`, `cc?`, `subject`, `body`, `in_reply_to?`) — simulated, lands in "sent" |
| `load_simulation` | Load a simulation package into an empty inbox, one message per case — create only |

Every change tool declares `receipt_id` in its schema; the gateway injects it,
agents do not set it.

---

## Simulation package

A flat JSON object shared with the ERP and CRM connectors
(`name`, `currency`, `customers`, `products`, `contacts`, `cases`) — this
connector reads only `cases` and ignores the rest:

```json
{
  "name": "Bergmann Ersatzteile GmbH",
  "cases": [
    {
      "id": "c1",
      "request": {
        "from": { "name": "Markus Huber", "email": "einkauf@huber.example" },
        "subject": "Quote please",
        "body": "...",
        "received_at": "2026-09-02T08:14:00.000Z"
      },
      "reply": { "subject": "Re: Quote please", "body": "..." },
      "notes": "optional — what was special about this case"
    }
  ]
}
```

- **Strictly validated**, refused whole on the first problem, naming the field
  (e.g. `cases[2].request.from.email`). Case ids must be unique.
- **`load_simulation` creates, it never edits.** Refused if a package was
  already loaded, or if any message already exists — "start from an empty
  database."
- One inbox message is created per case: `from` = the case's requester, `to` =
  a fixed simulated company address derived from the package name (e.g.
  `inbox@bergmann-ersatzteile-gmbh.simulated`), `received_at` = the case's
  `received_at` or the load time.
- **`cases[].reply` — the people's actual answer — is never reachable through
  any MCP tool.** It is stored in a separate table and surfaces only in the
  `export` CLI command, for scoring the agent's replies after the fact.

Example package: [`examples/package.example.json`](examples/package.example.json)
(3 cases for a spare-parts dealer: a quote request, an order where an item is
out of stock, and a delivery-date question).

---

## Simulation mode

The connector has a switch, `EMAIL_MODE`:

| Mode | What answers | Status |
|---|---|---|
| `simulation` (default) | the built-in simulated inbox (the database above) | available |
| `live` | a real mailbox | no adapter in 0.x — **every call is refused**, reads included, nothing is read or changed |

The point: a three-week test runs on exactly this connector, its tools and its
HAP profile. Only the system behind it is simulated, so the tickets issued
during the test are the same tickets that will be issued live.

**Changes.** Every successful `send_message` / `load_simulation` is recorded
in a `changes` table (time, tool, document id, summary, and the `receipt_id`
the gateway injected).

**Refusals after the gateway.** When the connector refuses a change call the
gateway already let through (bad recipient email, unknown `in_reply_to`, a
second `load_simulation`), it records the refusal with the `receipt_id` the
gateway injected — a ticket then exists for an action that never happened, and
this record is the only place that says so.

**Local command** (not an MCP tool — the agent can neither read nor change
it). Point it at the same database the gateway uses — for a gateway install
that is `HAP_DATA_DIR=~/.suveren`:

```bash
HAP_DATA_DIR=~/.suveren email-mcp export > record.json
```

`export` returns `{ mode, exported_at, simulation_load, inbox, sent, changes,
refusals, reference_replies }` — the **only** place `reference_replies`
(the people's actual answers) appears.

---

## HAP Profile

This server is gated through the `email` profile
(`github.com/humanagencyprotocol/hap-profiles/email@0.7`):

- **Action types** — `delete`, `send`, `setup`
- **Bounds** — `read_access`, `recipient_max`, `send_daily_max`, `setup_daily_max`
- **Scope** — `allowed_recipients`, `allowed_domains` (required for `send`)
- **Content binding (v2)** — `to`, `cc`, `subject`, `body` (`to` and `body`
  required), applies to `send`

---

## License

MIT

See [humanagencyprotocol.org](https://humanagencyprotocol.org) for the full protocol specification.
