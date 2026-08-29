# Phase M — Co-op sessions & piggybacking (DESIGN ONLY — nothing here is built)

> **Status: proposal.** No code exists for any of this. Every file path below is a
> *proposed* location, not an existing one. Read this as a thing to argue with.

## Premise

Keep multiplayer in a local-first app with no cloud, no web app, and no accounts —
by inverting what gets shared. Today's collaboration tools share *documents* and run
compute centrally. This shares **compute** and keeps documents local.

A guest with no fal key and no Claude subscription joins a host's live session, sees
their canvas, and proposes generations. The host's machine executes them with the
host's credentials, on the host's approval. **The key never leaves the host.**

> **Compute sharing without credential sharing.**

The guest is not a peer. The guest is a thin remote controller of the host's session.
That asymmetry is the whole design — it makes the host naturally authoritative and
removes the need for CRDT merge (see [Live view](#c-live-view)).

## Non-goals

- **No cloud persistence.** The relay routes ciphertext and stores nothing. Canvas
  state never lands on a server.
- **No accounts.** No email, no password, no reset flow, no user table. The
  login-less property from the local conversion is preserved.
- **No offline collaboration.** Sessions are live-only. If the host is away, there is
  no session.
- **No concurrent editing.** The guest proposes; the guest does not mutate.
- **Not a resale mechanism.** See [Why approval is structural](#why-approval-is-structural).

---

## A. Identity

Building accounts would undo the login-less property. Instead:

- On first launch, generate an **Ed25519 keypair**, stored beside the fal key in
  `config.json`.
- The **friend code is the public key fingerprint** — `matte:7f3a-9c21-…`, or a QR.
- Adding a friend = pasting a code exchanged out-of-band (Signal safety-number model).
- Contacts live in PGlite. Nothing server-side.
- Payloads are E2E encrypted (X25519). The relay is zero-knowledge — `wrangler tail`
  on it shows opaque blobs.

**Open:** key rotation and multi-device. A user reinstalling gets a new identity and
drops out of every friend list. Probably acceptable for v1; say so out loud in the UI.

## B. Rendezvous / transport

The one piece that must be hosted. Two consumer machines behind NAT cannot find each
other unaided.

It is a **dumb pipe**: a WebSocket hub routing ciphertext between two public keys.

- **Cloudflare Durable Objects** are close to purpose-built — one DO per live session,
  WebSocket hibernation so idle sessions cost ~nothing, no database.
- Optional WebRTC data-channel upgrade for bulk media once signaling completes, with
  the relay as TURN fallback.

This does not violate "no web app exposed." Nothing is served, nothing is stored, no
canvas ever touches it. It is a switchboard.

### Who pays for it

Pricing principle: **charge for what costs money or uptime; give away what costs only
time.** LAN is free and open — donated time, no infra. The relay is an external cost,
so it belongs to whoever incurs it.

**BYO relay is the first-class path.** The user deploys the Worker to their own
Cloudflare account (`wrangler deploy`) and pays CF directly. Identical in spirit to
the fal key and the Claude token: your account, your bill, no middleman. This is not a
fallback — it is the default for anyone willing to run one command.

A **hosted relay** may exist as convenience for people who won't. Its price covers
*uptime*, not bandwidth — be honest about that, and note that selling it means owning
an SLA. Keep LAN and self-host always available so a hosted-relay outage degrades
rather than breaks.

Metered passthrough is not viable: infra cost is ~$0.16/user/month at heavy usage
(see [Cost](#cost)), which is below Stripe's per-transaction floor. Billing transport
would cost more than the transport.

### Consequences for the protocol

- **The relay URL is configuration**, on the same shelf as `falKey` /
  `claudeCodeToken` in `config.json`. Hardcode it and BYO-relay becomes a fork instead
  of a setting.
- **The invite carries the relay endpoint** — two peers cannot rendezvous without
  agreeing on the switchboard. Roughly
  `matte:<relay>/<sessionId>#<hostPubkey>+<secret>`. The host's relay always wins,
  since the host is the authority. Omit this field and cross-relay sessions fail
  silently.

**Risk:** this is the real engineering unknown. NAT traversal on actual home networks
is where this kind of project dies. Prove it with an encrypted echo between two
installs before building anything on top.

## C. Live view

Host-authoritative. Host broadcasts canvas state; guest renders. Because the guest's
only write verb is `propose`, the guest→host channel is narrow and well-typed rather
than a general canvas-mutation API.

```
host  → guest    state     snapshot on join, then node diffs
guest → host     propose   a suggestion (see below)
host  → guest    stream    operator events, generation progress, media
```

**Media is the bandwidth trap.** Full video assets are tens of MB. Send
thumbnails/proxies live; fetch full assets on demand.

**Reusable today:**

| Existing | Reuse |
|---|---|
| `src/hooks/canvas/useCanvasSSE.ts` (153L) | Event-stream shape is right; the source changes |
| `server/routes/sharing.ts` (171L) + `services/projectAccess.ts` (87L) | SaaS-era role model — repoint at peers instead of accounts |
| `server/routes/operator.ts` | Already streams agent events incrementally — forwardable near as-is |
| `server/config/falCost.ts` + `services/falPricing.ts` (Phase L) | **The spend gate.** See below. |

## D. Suggestions

The core entity. A suggestion is a proposed generation the host must authorize.

```
proposed ──▶ approved ──▶ executing ──▶ landed
    │            │                   └─▶ failed
    ├─▶ rejected │
    └─▶ expired  └─▶ cancelled
```

Two distinct approval objects, because they carry different risk:

| | Object | Host sees | Auto-approvable? |
|---|---|---|---|
| Direct generation | intent card | model, prompt **verbatim**, params, est. USD | Yes, within tier |
| Agent turn | turn + spend ceiling | guest's request verbatim, ceiling, live spend | **Never** |

An agent turn may want six tool calls; six modals is unusable and a blank cheque is
wrong, so the host approves *the turn with a ceiling* and the agent works inside it.
Anything exceeding the ceiling escalates back.

**Required properties:**

- **Expiry.** A suggestion approved 40 minutes later, after the canvas moved on,
  generates something out of context and charges for it. Suggestions go stale.
- **Durability.** The host closes the lid mid-approval. The queue survives and
  re-presents cleanly — otherwise every network blip is a lost or double-fired
  generation.
- **Optimistic placeholder.** The guest sees a pending node land on the canvas the
  instant they propose. Waiting on a silent round-trip feels dead.
- **Provenance on the node** — *suggested by Ana · approved by Julia · $0.07 · 14:32*.
  Cheap now, miserable to retrofit. It is the audit trail that makes shared spend
  socially survivable, and most of the "remote team view" value on its own.
- **Rejection carries a reason.** Silent rejection feels bad between friends.

## E. Approval tiers

Two controls, not one. Conflating them is the trap:

- **Per-item ceiling** — what auto-approves without a click.
- **Session envelope** — what accumulates before it comes back.

| Tier | Per-item | Envelope | What it buys |
|---|---|---|---|
| **Light** | ≤ $0.10 | $1 | Images + audio. ~12 nano-banana, ~25 seedream, ~500 SFX. **No video.** |
| **Medium** | ≤ $1.00 | $10 | + short clips — Kling 5s ($0.70), Veo lite 8s ($0.64). Not Seedance. |
| **High** | ≤ $5.00 | $100 | Everything, including Seedance ($3.40). |

**Price does the model classification.** These ceilings partition the catalog into
image / short-video / premium-video with no allowlist to maintain — and a model fal
adds next month self-classifies. This only works because Phase L prices *at cost and
live*; a stale or marked-up table would misfile models into the wrong tier.

### Above the ceiling: escalate, never auto-approve

**Nothing above the tier's per-item ceiling auto-approves, at any tier, under any
condition.** No generation in the catalog costs $10 alone (Seedance tops out at
$3.40), so a $10+ request is *necessarily a batch* — a bulk commitment, and exactly
the thing that should cost a human glance. Such requests are rare; if a session fires
them routinely, the friction is reporting something true about the workflow.

The real problem in the neighbourhood is the opposite one: 30 variations for a client
deck should not be 30 cards. Fix that by making **the batch one legible approval
object**, not by relaxing the ceiling.

| Request total | Treatment |
|---|---|
| ≤ tier per-item | Auto-approve |
| up to $5 | One card, one tap |
| $5–$25 | Confirm card with batch breakdown — item count × unit × total |
| > $25 | Escalated confirm; deliberate action, not a tap |

### Rules

- **Gate on the whole-request estimate, not unit price.** 30 images at $0.08 sails
  past a $0.10 per-item check if you read unit cost. Batch total, always.
- **A rolling daily cap per guest, spanning sessions.** The envelope is per-session,
  so nothing otherwise stops five high-tier grants in one day — $500 total, each
  individually reasonable. The daily cap is a separate counter from the envelope and
  does not reset when a session ends.
- **Exhaustion degrades, never blocks.** Envelope spent → auto-approve stops, falls
  back to per-item approval. A wall mid-session is worse than a click.
- **Grants are presence-bound.** Leaving the session or closing the lid revokes every
  standing grant. This is both the ToS story (the host is *there*) and a kill switch
  that needs no UI.
- **Grants are time-boxed** on top of presence. High tier wants a shorter default.
- **Granting $100 ≠ granting $1.** Escalating trust deserves escalating
  deliberateness — high tier gets an explicit confirm, not the same one-tap.
- **Approximate estimates may overrun.** Token-billed models (Seedance) and
  compute-second models (pixelcut) are `~` estimates. Envelope accounting should
  reconcile against *actual* cost post-generation; accept small overrun rather than
  blocking on uncertainty.

Also needed: a **live spend meter** for the host and a **kill switch that halts
in-flight work**. Design the revocation path first — the fear isn't a friend
overspending, it's not being able to stop it.

## F. Security

### Why approval is structural

Sharing a **fal key** is between the user and fal — it's metered, at cost, and
delegating it is a normal use of an API key.

Driving a friend's **Claude subscription** is a different risk class. Consumer
subscriptions are priced for one person; account sharing is generally against consumer
terms, and one Max seat serving a team is squarely what that pricing exists to
prevent. Mandatory host approval is what makes this collaboration rather than
seat-sharing: every agent turn is authorized by a present human on the account that
owns it. That is why approval is not a setting — it is the design.

**Before shipping the Claude half, read the current Anthropic Consumer Terms.** The
fal half carries no such question.

### Untrusted input

The guest is now a remote party putting text into a process that spends money and
calls tools. "It's a friend" is not a security boundary — a friend's compromised
install is the threat.

- Guest text is **untrusted**. Mark it as such in the operator context.
- A guest intent must **never widen the tool set**. `--allowedTools` and
  `--strict-mcp-config` stay exactly as strict as Phase K set them.
- Intent cards show guest prompts **verbatim and untruncated**, visibly marked as
  guest-originated. A host clicking through a queue is not reading carefully — this is
  the one place to spend screen real estate.
- Standing grants never cover agent turns. That is where injected text becomes tool
  calls, and it always costs a human glance.

### Asset egress

Once a guest can pull full-res media off a host's disk, "view my project" quietly
becomes "exfiltrate my project." **Roles must gate asset download separately from
asset viewing.**

## G. Open questions

1. **Guest-side persistence.** Does the guest keep a copy of what they made on
   someone else's machine, or does it stay with the host? A product call with real
   feeling behind it — better made now than patched later.
2. **Partition semantics.** Host disconnects mid-generation. Host-authoritative
   answers it cleanly (it lands on the host, guest re-syncs) but the guest-side UX
   needs deciding.
3. **Multi-guest.** Does the envelope apply per-guest or per-session? Per-guest is
   more intuitive; per-session is safer for the host.
4. **Key rotation / multi-device** (see [Identity](#a-identity)).
5. **Relay abuse.** Even a zero-knowledge relay can be spammed. Rate-limit by pubkey.

## Cost

Cloudflare Workers Paid pricing **as of mid-2026 — verify before planning around it.**
Workers/DO bill requests + duration; **egress is not billed.** DO WebSocket
Hibernation means idle connections cost nothing.

| Line | Rate | Included |
|---|---|---|
| Workers Paid base | $5/mo | 10M req, 30M CPU-ms |
| DO requests | $0.15/M | 1M |
| DO duration (128 MB = 0.125 GB/s) | $12.50/M GB-s | 400,000 GB-s |
| Egress | $0 | — |

Cost tracks **concurrent session-hours, not user count.** 1000 users who never open a
session cost $5.

| Scenario (1000 users) | Session-hrs/mo | Total |
|---|---|---|
| Light — 10% active, 4×45min | 300 | ~$8 |
| Heavy — 25% active, 8×60min | 2,000 | ~$27 |
| **Every user a power user** — 20 hrs each | 10,000 | **~$160** (~$0.16/user) |
| Absurd — 500 sessions live 24/7 | 360,000 | ~$5,900 (physically implausible) |

Notes:

- **Requests overtake duration at scale**, driven by protocol chattiness. That is a
  design dial: batching deltas at 100ms instead of 10 Hz presence cuts the dominant
  line ~5×.
- **TURN is the one metered-bandwidth line.** Workers egress is free, but WebRTC
  fallback for symmetric-NAT peers needs TURN, billed per GB. Small at low volume, but
  it scales linearly with media — a reason to keep direct P2P healthy and full-res
  assets explicit.
- **Terms risk, not invoice risk.** Free Workers egress is generous, and CF's
  service-specific terms have historically restricted using the network as a
  general-purpose large-media pipe. Unnoticed at 1000 users; a conversation at 100,000.
- DO free tiers are **per account** — shared with anything else already on Workers.

**Cost is not a reason to delay any of this.** LAN costs nothing; the relay at the
first thousand users is a rounding error against a month of fal spend. The real
constraints are NAT success rate and host uplink.

### Decision: CF Workers relay, accept the risk

Every expensive scenario above requires a stack of conditionals — *if* users are ultra
power users, *and* there are a thousand of them, *and* it goes viral. The downside is
bounded and reversible, so take the cheap path: **CF Workers relay, no WebRTC.** If
costs spiral, pause remote sessions and ship a paid tier.

Self-hosted **coturn** on a Hetzner box (~$20/mo, 20 TB included) is the long-term
escape valve if per-GB TURN or Workers pricing ever bites — flat cost, good longevity.
Deliberately deferred: it trades a zero-ops serverless dependency for a server with an
uptime obligation, which is the cost this project is trying *not* to absorb.

**Three requirements that make "pause it" actually executable:**

1. **The relay refuses new sessions server-side**, with a structured reason the client
   renders. A client-side gate would need an emergency auto-update release and days of
   propagation; a server-side one throttles in seconds. Existing sessions drain rather
   than drop.
2. **LAN never touches the relay** — not for discovery, not for a version check, not
   for anything. If LAN calls home even once, a CF outage or a deliberate gate takes
   down the free tier too. Full independence is what makes the kill switch safe to pull.
3. **Emit a session counter** (DO → Analytics Engine) and set a CF billing
   notification. Cloudflare bills monthly, so without telemetry a viral spike is
   discovered up to 30 days late, via invoice. Workers has no hard spend ceiling as far
   as I know — confirm — so the alert is the only early warning.

## Latency

Estimates from typical network characteristics — **not measured.**

| Path | RTT |
|---|---|
| LAN | 0.5–2 ms |
| WebRTC direct, same metro | 10–25 ms |
| WebRTC direct, cross-continent | 80–150 ms |
| Relayed, same metro | 20–50 ms |
| Relayed, cross-continent | 150–300 ms |

**Approval latency is human — 2–30 s — and dominates everything by 50–500×.** Wire
optimization is nearly irrelevant to perceived speed; the approval UX is everything.
This is the strongest argument for tiers: auto-approve removes *seconds*, not
milliseconds.

**The shim keeps the guest's UI local-fast.** If the guest caches the snapshot in its
own PGlite, every read its React app makes is ~1 ms. Only *freshness* traverses the
network, so latency shows up as "I saw the host's change 60 ms late," never as sluggish
UI. Expect the first real bug here: stale cache during reconnect.

**Bandwidth is what users will call latency.** Residential uplink is asymmetric
(10–35 Mbps up) and the host is sending: thumbnails ~1–2 s, full image ~2–6 s, 5 s
video ~8–25 s. Mostly hidden inside generation waits, but it is the argument for
relaying control frames and proxies only.

**Placement gotcha:** a DO lives in *one* datacenter, chosen roughly by whoever creates
it. **The host must create the session** — otherwise two peers in one city can pay two
cross-continent hops.

Measure before trusting any of the above: (1) relayed RTT between two real residential
connections, (2) WebRTC direct-connect success rate on real home networks (the ~80%
figure is folklore), (3) host uplink on a typical user's line — if it is 5 Mbps,
full-asset relay is off the table.

## H. Phasing

1. **Transport + identity** — keypairs, friend codes, relay, encrypted echo between
   two installs. Nothing app-specific. *Prove NAT traversal on real home networks
   before building anything on top.*
2. **Read-only live view** — host projects canvas, guest watches. Ship-worthy alone:
   it is the shoulder-surf / remote-team-view case and carries zero spend risk.
3. **Fal piggyback** — suggestions, tiers, cost gate, meter, kill switch. The actual
   product.
4. **Operator piggyback** — host-in-the-loop only, pending the terms question.
5. **Roles / org** — observer / suggester / spender, multi-guest sessions.

Steps 1–2 carry the engineering risk. Step 3 is largely plumbing on top of Phase L.

### LAN vs. self-hosted relay: a `SessionTransport` interface

Put the seam at the socket — `connect(invite)` / `listen()` returning a `Channel` — and
LAN and relay are two implementations with nothing above them aware of the difference.

| Layer | LAN | Relay |
|---|---|---|
| Discovery | mDNS/DNS-SD on subnet | invite carries relay URL |
| Socket | direct WS to peer IP | WSS to Worker, forwarded |
| Identity, Noise, E2E | identical | identical |
| Frames, sequencing, resync | identical | identical |
| Suggestions, tiers, grants, ledger | identical | identical |
| Guest shim, all UI | identical | identical |

LAN is the cheaper build: the host already runs Express: it needs a WS upgrade handler
plus an mDNS advertisement. No Worker, no wrangler, no CF account.

Three genuine divergences:

- **Windows Firewall inverts the difficulty.** LAN needs an inbound listener → Defender
  prompt on first run, which users reflexively cancel. Relay is outbound-only and needs
  no exception. Request the exception at install time.
- **mDNS is spoofable** — anyone on the same wifi can advertise as your host. The Noise
  handshake against the host's static pubkey is therefore load-bearing on LAN too.
  Keep the crypto byte-identical across transports; do not "simplify" it for local.
- **Bandwidth policy diverges, code does not.** Transport advertises
  `bandwidthClass: 'lan' | 'direct' | 'relayed'`; asset policy reads that. LAN can move
  full-res freely; relayed cannot.

### WebRTC is probably droppable

LAN → relay is a small delta. **Relay → WebRTC is the entire rest of the project** —
ICE, candidate exchange, TURN, NAT-type detection — and it is the largest technical
risk in this plan.

The justification for WebRTC was bandwidth cost. **Free Workers egress removed it.**
What remains is lower latency (irrelevant — approval is human-dominated) and hiding
traffic volume from Cloudflare (metadata only; content is already E2E).

The one real residual argument is the CF terms risk: if Cloudflare ever objects to
being a media pipe, WebRTC is the escape hatch. Treat it as a contingency to *design
toward* — keep `SessionTransport` clean enough to accept a third implementation — not
as work to schedule.
