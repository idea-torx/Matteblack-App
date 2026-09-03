---
name: Setup — connecting fal.ai
description: No fal key or auth errors: fal.ai, $1 of credit, the key, Settings → Providers, then check_setup.
---

# Setup — connecting fal.ai

Fetch this when a generation fails with an auth error, `check_setup` says no key, or the user asks how to
get started or connect fal. The app generates with the user's own fal.ai account; nothing works until a
key is saved. You never see the key — the user pastes it into Settings and the app keeps it locally.

## Walk them through it, one message

1. Go to https://fal.ai and sign in (GitHub or Google works).
2. Add credit at https://fal.ai/dashboard/billing — as little as $1 is enough to start; a draft clip on
   H3 Turbo at 480p is a few cents.
3. Create a key at https://fal.ai/dashboard/keys and copy it.
4. In this app: Settings → Providers → fal.ai → paste the key → Save.
5. Tell me when it is saved and I will check it.

Keep it to those five lines. Do not ask them to paste the key in the chat; if they do, tell them to
delete that message and use Settings instead.

## Then run the check

Call `check_setup`. It reports whether a key is saved and whether fal accepts it, without revealing it.

- Accepted: say so, then ask what they want to make (fetch `help` if they are unsure).
- Rejected: they copied it wrong or revoked it — back to https://fal.ai/dashboard/keys, paste again, Save.
- Unreachable: fal or the network is down; try again in a minute.

If a generation later fails with a balance or credit error, point them to
https://fal.ai/dashboard/billing rather than retrying.
