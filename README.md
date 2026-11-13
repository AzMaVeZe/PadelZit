# 🎾 פאדלז׳יט — PadelZit

A score-keeping app for padel Americano/Mexicano tournaments with 4–12 players (two parallel courts from 8 players up). Hebrew (RTL) by default, with a one-tap English toggle. No signup needed — open and play.

## Features

- **Multi-tournament home screen** — start a new tournament, continue a live one, or revisit finished ones. Player names are remembered between tournaments.
- **4–12 players, shuffled pairs** — with 5-7 players, the 4 with the fewest games play each game (partners chosen to minimize repeats) and the rest rest; from 8 players up, each round fills **two parallel courts** (8 play, the rest rotate in), so playing time stays even and nobody benches half the evening.
- **With exactly 4 players** — with 4 players there are 3 possible team combinations; the app cycles through all of them in random order before reshuffling (never repeating the same pairing twice in a row), so everyone partners with everyone. The round/cycle position is shown ("Game 4 · Round 2 (1/3)").
- **Games to a configurable total** (default 32 points) — type one team's score and the other fills in automatically. The 🎯 target can be changed mid-tournament; each game remembers the target it was played to.
- **Live ranking** — points, point differential (+/−) and wins per player; ties broken by wins, then differential.
- **Editable history** — fix any past game's score (✎); standings recompute instantly.
- **Finish & podium** — crown the winner with a 🥇🥈🥉 podium and final table.
- **Share on WhatsApp** — send the standings to friends with one tap (or copy as text).
- **All-time leaderboard** — aggregated points, wins and 🏆 titles across all tournaments, saved on the device.
- **Cloud accounts** — email / Google / Facebook sign-in (Supabase, PKCE); tournaments sync across devices, with self-serve account+data deletion.
- **Mexicano mode** — optional format where, from round 2, pairs are set by standing (1+4 vs 2+3) for closer games.
- **Public results link** — publish a finished tournament to a read-only page (`r.html`) and share it; opens with an install call-to-action.
- **Privacy policy** at `privacy.html`.
- Robust storage: corrupted/legacy saves are sanitized, multiple open tabs stay in sync, and the app still works where localStorage is blocked (memory fallback).

## Running it

No build step, no server, no dependencies — a single HTML file.

Open `index.html` in any browser, or serve it locally:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Works well on a phone at the court.

## Tests

End-to-end tests drive the app in Chromium (Playwright) against a local mock
of Supabase (`mock-supabase.js`). Run them all, each with a fresh mock:

```sh
./scripts/run-tests.sh
```

They also run on every pull request (`.github/workflows/tests.yml`).

## Cloud schema changes

`cloud/setup.sql` builds a fresh Supabase project from scratch. Changes to an
existing project go in `cloud/migrations/` (dated, idempotent) and are folded
into `setup.sql` as well.

## Install as an app (PWA)

The hosted site is a Progressive Web App — no store, no signup, works on Android
and iPhone:

- **Android (Chrome):** open the site → menu (⋮) → **Install app** / **Add to Home screen**.
- **iPhone (Safari):** open the site → Share → **Add to Home Screen**.

You get a home-screen icon, a full-screen app (no browser bars), and offline use
(a service worker caches the app shell). Cloud sync still needs a connection.
PWA assets live in `pwa/` (manifest, service worker, icons) and are published
alongside `index.html` by the Pages workflow.

## Android app (Google Play)

The Android build is a **Trusted Web Activity** — a thin native wrapper that
opens the live site fullscreen (no address bar) and picks up every web deploy
automatically, so shipping app content never needs a store review.

- Config: `twa/twa-manifest.json` (Bubblewrap, package `app.azma.padel`).
- Build: run the **Build Android app (TWA)** workflow from the Actions tab; it
  produces a signed `.aab` for Play plus an `.apk` for sideload testing.
- Ownership proof: `pwa/.well-known/assetlinks.json`, published to
  `https://padel.azma.app/.well-known/assetlinks.json` by the Pages workflow.
  Without a matching fingerprint there, the app shows a URL bar.
- Step-by-step release instructions: [`PLAY.md`](PLAY.md).

Signing keys are never committed — the upload key lives only in the
`ANDROID_KEYSTORE_BASE64` repository secret.

## Accounts & services

See [`ACCOUNTS.md`](ACCOUNTS.md) for which external service (GitHub, domain
registrar, Supabase, OAuth providers, ...) is tied to which account. That file
is redacted since this repo is public; the full version with real logins is
`ACCOUNTS.local.md` on the maintainer's machine (gitignored, never committed).
Update both together whenever a service is added or an account changes.

## Roadmap

- Live shared tournament view (realtime leaderboard for all participants)

These require a small backend (e.g. Firebase/Supabase); the current app is intentionally 100% client-side and signup-free.
