# Magic Routing Worker

A Cloudflare Worker that enables customer-defined call routing logic for FreeSWITCH/FusionPBX. Customers describe routing rules in plain language, an LLM generates JavaScript code, and that code executes in an isolated Cloudflare Dynamic Worker at call time to make real-time routing decisions.

## How It Works

```
Incoming Call
  → FreeSWITCH dialplan hits "magic_routing" action
    → Lua script collects call context (caller ID, destination, time, etc.)
      → HTTP POST to this Cloudflare Worker with block ID + call context
        → Worker fetches customer's JS code from PostgREST/Postgres
          → Code loads into a Dynamic Worker (V8 isolate, millisecond startup)
            → Customer code runs (can call external APIs: weather, CRM, etc.)
            → Returns routing decision: { app, data }
          → Response sent back to Lua script
        → Lua executes the FreeSWITCH application (transfer, bridge, etc.)
      → Call is routed
```

Magic routing is a single block in a call flow, used alongside existing FusionPBX primitives like ring groups, IVR menus, voicemail, and time conditions.

## Architecture

- **Cloudflare Dynamic Workers** — V8 isolates that start in milliseconds with no containers, no Docker, no lifecycle management. Each customer's code runs in a fully isolated sandbox.
- **PostgREST** — The Worker fetches customer code from the `magic_routing` table via PostgREST (fronted by Cloudflare).
- **FreeSWITCH Lua** — A Lua script in the FusionPBX dialplan scripts directory handles the HTTP call and executes the routing decision.

## Customer Code

Customers write (or an LLM generates) a `route(ctx)` function that receives call context and returns a routing decision:

```javascript
async function route(ctx) {
  // Check the weather for dynamic routing
  const resp = await fetch("https://api.weather.com/current?zip=10001");
  const weather = await resp.json();

  if (weather.condition === "sunny") {
    return { app: "transfer", data: "100 XML default" };
  }
  return { app: "transfer", data: "200 XML default" };
}
```

### Call Context (`ctx`)

The Lua script passes these channel variables to the customer's code:

| Field | Description |
|---|---|
| `uuid` | Call UUID |
| `direction` | Call direction (inbound/outbound/local) |
| `caller_id_number` | Caller's phone number |
| `caller_id_name` | Caller's name |
| `destination_number` | Dialed number |
| `domain_name` | FusionPBX domain |
| `domain_uuid` | Domain UUID |
| `context` | Dialplan context |
| `accountcode` | Account code |
| `start_epoch` | Call start time (epoch) |
| `network_addr` | Caller's IP address |
| `sip_from_user` | SIP From header user |
| `sip_to_user` | SIP To header user |
| `sip_user_agent` | Caller's SIP user agent |
| `timezone` | Domain timezone |

### Routing Decision

The function must return an object with `app` and `data`:

| `app` | `data` format | Description |
|---|---|---|
| `transfer` | `"destination dialplan context"` e.g. `"100 XML default"` | Transfer to an extension, ring group, IVR, voicemail, etc. |
| `bridge` | `"sofia/internal/user@domain"` | Bridge to a specific SIP endpoint |
| `playback` | `"/path/to/file.wav"` | Play an audio file |
| `set` | `"variable=value"` | Set a channel variable (returns `continue_routing: true` to continue the dialplan) |
| `hangup` | `"NORMAL_CLEARING"` | Hang up with a cause code |

FusionPBX primitives (ring groups, IVRs, voicemail, etc.) are reached via `transfer` to their well-known destinations.

## Database

The `magic_routing` table in PostgreSQL:

```sql
CREATE TABLE magic_routing (
    magic_routing_uuid  uuid          NOT NULL DEFAULT gen_random_uuid(),
    domain_uuid               uuid,
    block_name                text,
    block_description         text,
    code                      text          NOT NULL,
    fallback_destination      text,
    fallback_context          text          DEFAULT 'default',
    enabled                   text          DEFAULT 'true',
    insert_date               timestamptz   DEFAULT now(),
    insert_user               uuid,
    update_date               timestamptz,
    update_user               uuid,
    CONSTRAINT magic_routing_pkey PRIMARY KEY (magic_routing_uuid)
);
```

## FreeSWITCH Integration

### Lua Script

The Lua script lives at `app/switch/resources/scripts/magic_routing.lua` in the [fusionpbx repo](https://github.com/emaktel/fusionpbx).

### Dialplan Usage

Add a magic routing block to a dialplan:

```xml
<action application="lua" data="magic_routing.lua {block_uuid} {fallback_destination} {fallback_context}"/>
```

Example:

```xml
<action application="lua" data="magic_routing.lua 34b02c1d-e7a6-465c-85f4-6312a3dbd1dc 200 default"/>
```

- `block_uuid` — The magic routing block ID from the database
- `fallback_destination` — Where to route if the worker errors or times out
- `fallback_context` — Dialplan context for the fallback (defaults to `default`)

### Environment Variables

Set on the FreeSWITCH server (in `/etc/environment`):

| Variable | Description |
|---|---|
| `MAGIC_ROUTING_WORKER_URL` | The deployed Worker URL |
| `MAGIC_ROUTING_API_KEY` | Shared secret for authenticating requests to the Worker |

FreeSWITCH must be restarted after changing these.

## Deployment

### Prerequisites

- Cloudflare Workers Paid plan
- Node.js 20+
- Wrangler CLI authenticated (`npx wrangler login`)

### Configuration

1. Set the PostgREST URL in `wrangler.jsonc`:

```jsonc
"vars": {
    "POSTGREST_URL": "https://your-postgrest-endpoint.com/api"
}
```

2. Set secrets:

```bash
npx wrangler secret put MAGIC_ROUTING_API_KEY
npx wrangler secret put POSTGREST_API_KEY
```

### Deploy

```bash
npm install
npx wrangler deploy
```

## Error Handling

If anything goes wrong — worker timeout, bad response, invalid app, customer code error — the Lua script transfers the call to the fallback destination. A customer's broken code never results in a dead call.

The Worker also validates routing decisions server-side, rejecting any `app` not in the whitelist (`transfer`, `bridge`, `playback`, `set`, `hangup`).

## Security

- **API key auth** between FreeSWITCH and the Worker
- **PostgREST JWT auth** between the Worker and the database
- **V8 isolate sandboxing** — customer code runs in a fully isolated environment
- **App whitelist** — only approved FreeSWITCH applications can be executed
- **Outbound fetch allowed** — customer code can call external APIs (weather, CRM, etc.)
