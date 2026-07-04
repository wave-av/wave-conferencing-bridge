# Ingress — Zoom Meeting-SDK bot (M2, task #88)

Status: **INERT scaffold.** Schemas + planners are live and tested; the actual
Zoom join is Wave-2 and is gated on the Meeting-SDK credential being present at
launch. This document is the design of record (the original scaffold `ad339e6`
was lost before it was pushed — see the durability note at the bottom).

## Why this exists (vs the RTMP ingress)

There are two ways Zoom media reaches WAVE:

| Path | Task | How | Human? | Zoom tier |
|---|---|---|---|---|
| **RTMP ingress** (`bindRtmpIngress`) | #90 / M3 | Operator pastes a WAVE push-URL into Zoom's **Live stream** settings; Zoom pushes its program feed out over RTMPS | yes | Zoom Pro |
| **Meeting-SDK bot** (this) | #88 / M2 | A headless **bot joins the meeting** via the Zoom Meeting SDK, pulls the raw/composited stream, and republishes into WAVE | no | any |

M2 needs no human and no Zoom-Pro live-stream. It also lets us run a **bot
farm**: N synthetic bots, each presenting a looped, watermarked clip, generating
deterministic meeting media for the perception pipeline (#85) with no real
participants.

## Shape

```
planMeetingSdkBotFarm(config)         bindMeetingSdkIngress(config)
        │                                      │
        └── N × ──────────────┐                └── 1 ×
                              ▼
                    MeetingSdkBotBinding
                    { meetingNumber, botDisplayName, video,
                      waveTarget: whip|rtmp, requiredEnv, armed, plan }
                              │
              armed? ────────┴─────────── no → INERT (planning only)
                 │
                 ▼ (Wave-2)
      Meeting-SDK join → capture raw media → republish to waveTarget
                 (WHIP = wave-native / M1 parity; RTMP = reuse ingest)
```

- **Config** is validated by zod (`src/types/meeting-sdk.ts`). `waveTarget` is a
  discriminated union on `mode` (`whip` | `rtmp`).
- **Credentials** are referenced by env-var NAME, never value
  (`credentialRef` → defaults `ZOOM_MEETING_SDK_KEY` / `ZOOM_MEETING_SDK_SECRET`).
  The bot reads them at launch under `doppler run`.
- **`armed`** is `true` only when both credential env vars are present. Until
  then every binding's `plan` is `INERT: … not set — planning only, no Zoom join`.

## What arms it

1. A Zoom Marketplace **Meeting SDK** app exists (task #87) — this is a DISTINCT
   credential from the OAuth / Server-to-Server / Zoom-Apps client secrets.
2. `ZOOM_MEETING_SDK_KEY` + `ZOOM_MEETING_SDK_SECRET` are added to Doppler
   (`wave/prd`). **As of 2026-07-04 these are NOT in Doppler** — only
   `ZOOM_CLIENT_*`, `ZOOM_APPS_*`, `ZOOM_S2S_*` are. This is the M2 gate.

## Wave-2 (not in this PR)

- Add the Zoom Meeting SDK dependency (Linux/headless variant for the bot farm).
- Implement the join + raw-media capture + republish to `waveTarget`.
- Watermark/label the looped source so farm media is self-identifying in the index.
- Meter the tapped media through the same one-subscribe surface as M1 (#91).

## Durability note

The first M2 scaffold was committed locally (`ad339e6`, branch `m2-zoom-inert`)
in an ephemeral worktree and pruned before it was ever pushed — truly lost. This
rebuild is authored against the existing ingress adapter contract and is pushed +
PR'd immediately. See the guard: a local commit is not durable until pushed.
