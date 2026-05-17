# Buildday Vote

A live pitch voting app for hackathons. Three browser surfaces, one Node process: an admin phone runs the mic, a projector laptop shows the pitch list and tally, audience phones vote.

The interesting bit: pitches aren't typed in ahead of time. The admin phone streams audio to OpenAI Realtime (`gpt-4o-transcribe`) over WebRTC. The server keeps a rolling 5-minute transcript and re-sends it to `gpt-5.4-mini` every 8-30 seconds, asking for the current pitch list back. New pitches show up on the display within about 30 seconds of being introduced. Manual edits in the admin always win.

![Display screen during voting: left column shows seven auto-detected pitches with the current one highlighted, right column shows the QR code, vote URL, and live ballot counter.](docs/screenshots/display-intake.png)

> All screenshots in this README are mocks: same brand, same layout, demo data.

## The three screens

### Display (`/display`)

Runs full-screen on the projector laptop. During pitching, it shows the live pitch list as the analyzer detects them. When the admin opens voting, the QR code and a running ballot counter appear alongside the pitch list. When the admin reveals results, the whole screen switches to a bar chart with confetti.

| During pitches and voting | Results reveal |
|---|---|
| ![Display during voting.](docs/screenshots/display-intake.png) | ![Results screen: top 3 pitches as horizontal bars with vote counts and percentages. Winner row glows mint with a trophy.](docs/screenshots/display-results.png) |

### Admin (`/admin`)

Runs on the mic operator's phone. Gated by `ADMIN_TOKEN`. Has the Start/Stop recording button, the live transcript, an editable pitch list, the four-stage poll controller (Draft, Open, Close, Reveal), and the staged-reveal panel.

Editing a pitch sets a `locked` flag on it. The analyzer copies locked pitches through unchanged on every subsequent pass, so manual fixes stick. There's also an undo button that rolls back the last few mutations.

<p align="center">
  <img src="docs/screenshots/admin.png" alt="Admin console on a phone: Microphone section with red Stop button and live transcript, then Pitches list with live/done badges, then Poll Stage (Draft active), then Results Reveal stepper." width="360">
</p>

### Vote (`/vote`)

Runs on every audience phone, reached by scanning the QR that appears on the display the moment voting opens. Multi-select checkboxes: tap as many pitches as you want, change your mind until voting closes. The pitch list is frozen at that point (the analyzer stops running once voting opens), but the page still re-syncs without refreshing if the admin manually tweaks a pitch in flight.

<p align="center">
  <img src="docs/screenshots/vote.png" alt="Voter ballot on a phone: title 'Pick your favorites', six pitches as tappable cards, three selected in mint, fixed bottom bar with a big blue 'Submit 3 picks' button." width="360">
</p>

## How it works

```
┌──────────────┐   WebRTC   ┌─────────────────────┐
│ admin phone  │ ─────────► │ OpenAI Realtime     │
│ /admin       │            │ (gpt-4o-transcribe) │
└──────┬───────┘            └─────────┬───────────┘
       │ transcript segments (JSON POST)
       ▼
┌──────────────────────────────┐     ┌───────────────────────┐
│ Next.js server (single proc) │ ──► │ OpenAI Chat           │
│ • in-memory state            │     │ Completions           │
│ • rolling 5-min transcript   │ ◄── │ (gpt-5.4-mini, JSON)  │
│ • SSE fan-out                │     │ pitch boundaries      │
└──────┬───────────────┬───────┘     └───────────────────────┘
       │ SSE           │ SSE
       ▼               ▼
┌──────────────┐ ┌──────────────┐
│ display      │ │ voter phones │
│ /display     │ │ /vote        │
└──────────────┘ └──────────────┘
```

A few things worth knowing:

- Pitch boundaries are semantic, not silence-based. Each analyzer pass sees the last 5 minutes of transcript plus the current pitch list and returns the updated list. It handles MC intros, applause, pauses, and Q&A without false triggers.
- The analyzer can update existing pitches and append new ones. It can't delete. An older version let it "consolidate" the list and once silently dropped 10 of 15 pitches when the rolling window aged past them. Deletions are admin-only now.
- Admin edits set `locked: true` on the pitch. Subsequent analyzer passes copy locked pitches through unchanged.
- Real-time updates use Server-Sent Events. Every mutation rebroadcasts the full public poll state via `publicState()` in [lib/store.ts](lib/store.ts). The state is small enough that this stays cheap with a few dozen connected clients.
- Analyzer cadence is bounded by two constants in [lib/store.ts](lib/store.ts): `ANALYZER_MIN_INTERVAL_MS = 8000` (no more often than every 8s) and `ANALYZER_MAX_INTERVAL_MS = 30000` (forced pass every 30s while recording, even if no new audio arrived).

## Quick start

You need Node 18+, an OpenAI API key, and a microphone.

```bash
git clone https://github.com/brian-archipelago/Buildday-vote.git
cd Buildday-vote
npm install
cp .env.example .env       # fill in OPENAI_API_KEY and ADMIN_TOKEN
npm run dev
```

Open three browser tabs (or three devices on the same Wi-Fi pointed at your laptop's IP):

| Surface | URL | Open on |
|---|---|---|
| Display | http://localhost:3000/display | Projector laptop |
| Admin | http://localhost:3000/admin | Mic operator's phone |
| Voter | http://localhost:3000/vote | Audience phones |

Tap Start recording in the admin, grant mic permission, start talking. Pitches should appear on the display within about 30 seconds.

## Configuration

Two required env vars:

```bash
OPENAI_API_KEY=sk-...
ADMIN_TOKEN=pick-something-hard-to-guess
```

`OPENAI_API_KEY` is your real OpenAI API key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys).

`ADMIN_TOKEN` is a password you invent. It can be any string. It's the only thing protecting the admin console, so make it hard to guess (`openssl rand -base64 24` gives you a solid one) and don't reuse a real password. When you open `/admin`, you'll paste this exact string into the login box; the admin's browser stores it in localStorage so you only enter it once per device. To change it later, update the env var and restart the server, which logs out every admin device.

### OpenAI models

| Job | Model | Where it's set |
|---|---|---|
| Speech-to-text from the admin phone | `gpt-4o-transcribe` | [app/api/realtime-session/route.ts](app/api/realtime-session/route.ts) |
| Pitch boundary detection | `gpt-5.4-mini` | [lib/analyzer.ts](lib/analyzer.ts) (`MODEL` constant) |

Both use the same `OPENAI_API_KEY`. The transcription model runs WebRTC straight from the admin browser to OpenAI using a short-lived ephemeral token the server mints, so the real API key never leaves the server.

Swapping the analyzer is a one-line change: edit the `MODEL` constant in [lib/analyzer.ts](lib/analyzer.ts) and adjust the prompt if needed. Swapping the transcriber is heavier: it means rewriting both the session-mint route and the WebRTC code in [app/admin/page.tsx](app/admin/page.tsx).

### Cost

For a 30-minute session with 8-12 pitches, at OpenAI's pricing as of writing:

- Transcription (`gpt-4o-transcribe`): about $0.006/min × 30 min ≈ $0.18
- Analyzer (`gpt-5.4-mini`): a few thousand input tokens per pass every 8-30s, with OpenAI's automatic prompt caching on the stable prefix (system prompt + existing-pitches block) ≈ a few cents

Check [OpenAI pricing](https://openai.com/api/pricing/) for current rates.

## Deploying to Railway

The app needs a long-lived Node process (in-memory state, persistent SSE connections), so most serverless hosts won't work. Railway is a clean fit: pay-per-second containers, automatic Next.js detection, env vars in the dashboard. The free trial covers a single hackathon.

One-time setup:

1. Push your fork to GitHub.
2. Sign in at [railway.app](https://railway.app), then New Project → Deploy from GitHub repo.
3. Pick the repo. Railway builds it.
4. In the service's Variables tab, add `OPENAI_API_KEY` and `ADMIN_TOKEN`.
5. The first deploy takes about 2 minutes. Railway gives you a `*.up.railway.app` URL.
6. Optional: attach a custom domain under Settings → Networking.

Railway uses these defaults out of the box:

- Build: `npm run build`
- Start: `npm start`
- Port: `$PORT` (Next.js respects this)

### Don't scale horizontally

State lives in one Node process's memory. Keep the replica count at 1. Two replicas would each have their own pitch list, and SSE clients on one would never see updates from the other.

A single Railway service handles a 40-person event comfortably. Scaling out means moving state into Redis and putting Redis pub/sub behind the SSE fan-out, which means rewriting [lib/store.ts](lib/store.ts) and [app/api/events/route.ts](app/api/events/route.ts).

### Other hosts

Anything that runs a long-lived Node 18+ process works: Fly.io, Render, a VPS, your own laptop on the venue Wi-Fi. Vercel won't work as-is: its serverless function timeouts cut SSE streams short (10s on Hobby, 15s on Pro by default), and there's no shared memory between invocations to hold the pitch list.

## Running an event

The short version:

1. Open `/display` full-screen on the projector laptop.
2. Open `/admin` on the mic operator's phone, paste `ADMIN_TOKEN`, tap Start recording.
3. Leave the poll in Draft while pitches happen. The display fills in automatically. Edit titles in the admin if the AI mishears.
4. Tap Open Voting when pitching ends. The display shows the QR. Voters scan and pick.
5. Tap Close Voting, then Reveal Results. Use the Results Reveal panel to pace the reveal (winner first, then 2nd, then 3rd, then **Show remaining** for the rest).

Full operator runbook with screenshots, every admin control explained, and troubleshooting: **[docs/RUNNING_AN_EVENT.md](docs/RUNNING_AN_EVENT.md)**.

## Project layout

```
app/
  admin/page.tsx            mic operator UI; WebRTC + pitch CRUD + reveal controls
  display/page.tsx          projector UI; pitch list, QR, results bars
  vote/page.tsx             voter ballot UI
  api/
    events/route.ts         SSE broadcaster
    realtime-session/       mints OpenAI ephemeral tokens for the admin WebRTC
    transcript/route.ts     ingests transcript segments from the admin
    pitch/                  pitch CRUD + undo
    poll/route.ts           draft/open/closed/results state transitions
    reveal/route.ts         staged-reveal controls
    vote/route.ts           voter ballot submission
    twinkle/route.ts        per-vote animation fan-out
    admin/verify/route.ts   admin token check
lib/
  store.ts                  in-memory poll state + event emitter
  analyzer.ts               gpt-5.4-mini boundary analyzer with rolling window
  tally.ts                  vote counting + tie-aware ranking
  auth.ts                   ADMIN_TOKEN gate
  client.ts                 admin/voter localStorage helpers
  useLiveState.ts           SSE subscription hook
docs/
  pipeline-explainer.html   standalone visual explainer of the analyzer pipeline
  screenshots/              README assets (PNGs + HTML mockup sources)
```

## Limitations

- No disk persistence. State lives in process memory. The store is hung off `globalThis` so it survives Next.js dev-mode hot reloads, but a real process restart (deploy, crash, `npm start`) wipes the pitch list, ballots, transcript window, and undo history. By design: a hackathon poll has a short useful life. If you want durable history, write to disk in [lib/store.ts](lib/store.ts).
- Single instance only. State is in-process memory. See the Railway section above.
- One concurrent recording session. The admin UI assumes one mic operator. Opening `/admin` on a second device while the first is recording will start a separate OpenAI session.
- English-only transcription prompt. The Realtime session is configured for English with a hackathon-vocabulary hint. Change the `language` and `prompt` fields in [app/api/realtime-session/route.ts](app/api/realtime-session/route.ts) for other languages.
- No moderation. Anyone with the vote URL can submit a ballot. Voters get a per-browser ID from localStorage so casual double-voting from the same phone is dedup'd, but it isn't tamper-proof. Good enough for a hackathon, not for a real election.

## Contributing

Open PRs welcome. Things that would be useful:

- A second transcription backend (Whisper, AssemblyAI, Deepgram) behind an env switch.
- An optional Redis-backed store for multi-instance deployments.
- Non-English Realtime configs.

## License

[MIT](LICENSE).

Originally built for [VSW Build Day](https://www.vanstartupweek.ca/) by [Archipelago](https://archipelagoaec.com).
