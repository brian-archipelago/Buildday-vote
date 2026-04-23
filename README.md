# Buildday Vote

A live, AI-powered pitch voting app for hackathons. Three surfaces running on different devices, all synced in real time:

- **`/admin`** — Mic operator (phone). Streams audio to OpenAI Realtime (`gpt-4o-transcribe`) via WebRTC. Claude Haiku continuously analyzes a rolling 5-minute transcript window and writes pitches automatically. Full manual override: add / edit / delete / reopen any pitch.
- **`/display`** — Projection screen (laptop). Big animated pitch list, QR code for voters, live vote count, animated bar-chart results with winner confetti.
- **`/vote`** — Voter ballot (phones). Multi-select checkboxes, can be updated until the poll closes. Live-updates without refresh as new pitches are recognized.

Real-time fan-out is Server-Sent Events. State is held in-memory in a single Node process.

## Architecture

```
[admin phone] ──WebRTC──► OpenAI Realtime (gpt-4o-transcribe, server VAD)
      │
      │ transcript segments (JSON POST)
      ▼
[Next.js server] ── rolling 5-min transcript window ──► Claude Haiku analyzer
      │                                                  (merges pitches)
      │
      └─ SSE ──► [display laptop]  [voter phones]
```

- **Pitch boundary detection** is *semantic*, not silence-based. The analyzer sees the last 5 minutes of transcript and decides where pitches start/end — handling MC announcements, applause, pauses, and Q&A without false triggers.
- **Locked pitches**: any admin edit flags a pitch as `locked`; the analyzer copies it through verbatim on subsequent passes, so hand-edits always win.
- **Real-time updates**: SSE `/api/events` broadcasts the full public poll state on every mutation. No refresh anywhere.

## Setup

```bash
npm install
cp .env.example .env
# fill in ANTHROPIC_API_KEY, OPENAI_API_KEY, ADMIN_TOKEN
npm run dev
```

Open three browser windows / devices:

- Display (laptop): `http://localhost:3000/display`
- Admin (phone or laptop): `http://localhost:3000/admin` → enter `ADMIN_TOKEN`
- Voter (phones): `http://localhost:3000/vote`

## Deploying to Railway

This app needs a long-lived Node process for SSE + in-memory state — Railway is ideal.

1. Push this repo to GitHub.
2. `railway up` (CLI) or create a new project on railway.app → **Deploy from GitHub repo**.
3. In the Railway service → **Variables**, set:
   - `ANTHROPIC_API_KEY`
   - `OPENAI_API_KEY`
   - `ADMIN_TOKEN` (pick something hard to guess)
4. Railway auto-detects Next.js and uses:
   - Build: `npm run build`
   - Start: `npm start`
   - Port: `$PORT` (already respected by `next start`)
5. Attach a custom domain or use the generated `*.up.railway.app` URL. Put that URL in the admin page's browser — the display page will render its QR pointing at `<origin>/vote`.

### One quirk to know

In-memory state means **one service instance only**. Don't scale horizontally — do not raise the replica count above 1. (For a 40-person event, a single instance handles this workload with room to spare.) If you ever need horizontal scale, state would need to move to Redis and SSE fan-out would need a pub/sub broker.

## On the day of the event

1. Open `/display` on the projector laptop, full-screen.
2. Open `/admin` on the mic operator's phone, sign in with `ADMIN_TOKEN`.
3. Tap **Start recording**. Grant mic permission.
4. Leave the poll in **Draft** while pitches happen — pitches appear on the display automatically as Claude detects them. Scan the QR with your own phone and `/vote` will show "voting hasn't opened yet" — scanning early is fine.
5. After pitches: tap **Open Voting**. The display now shows the QR; voters scan and submit.
6. After the vote window: **Close Voting**, then **Reveal Results**. The display animates the bar chart and drops confetti on the winner.

## Costs

- Claude Haiku analyzer calls: ~1–3k input tokens per pass, every ~15–30s. A 30-min session runs well under $0.10.
- OpenAI Realtime `gpt-4o-transcribe`: ~$0.006/min of audio. 30 min ≈ $0.18.
- Total cost per event: less than the price of a coffee.

## Files

- `lib/store.ts` — in-memory state + event emitter
- `lib/analyzer.ts` — Claude pitch-boundary analyzer with rolling window + prompt caching
- `app/api/events/route.ts` — SSE broadcaster
- `app/api/realtime-session/route.ts` — mints OpenAI ephemeral tokens
- `app/api/transcript/route.ts` — admin-side transcript ingestion
- `app/api/{pitch,poll,vote}/route.ts` — CRUD + voting
- `app/{admin,display,vote}/page.tsx` — three client surfaces
