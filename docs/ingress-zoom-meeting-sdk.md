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
  (`credentialRef` → defaults `ZOOM_APPS_CLIENT_ID` / `ZOOM_APPS_CLIENT_SECRET`).
  The bot reads them at launch under `doppler run`.
- **`armed`** is `true` only when both credential env vars are present. Until
  then every binding's `plan` is `INERT: … not set — planning only, no Zoom join`.

## What arms it

1. The credentials that sign the Meeting-SDK JWT. Standalone Marketplace
   **Meeting SDK** apps are deprecated — a **General app's** Client ID / Client
   Secret now serve as the Meeting-SDK "SDK Key"/"SDK Secret". For WAVE that
   General app is already provisioned as `ZOOM_APPS_CLIENT_ID` /
   `ZOOM_APPS_CLIENT_SECRET` (verified 2026-07-04 by public Client-ID match).
2. Because those are **already in Doppler** (`wave/prd`), the credential gate is
   satisfied. What remains for Wave-2 is the runtime: adding the Zoom Meeting
   SDK dependency + the headless client that performs the join and media pull.

## Wave-2 (the join path)

The join orchestration now lives in `src/ingress/meeting-sdk-launch.ts`
(`launchMeetingSdkBot` / `launchMeetingSdkBotFarm`), **double-gated + INERT by
default**. A join happens only when BOTH hold:

1. the flag `ZOOM_MEETING_SDK_INGRESS_ENABLED` is ON (defaults OFF/absent), and
2. the Meeting-SDK credential is present (`isMeetingSdkArmed`).

If either is false the launcher returns `{ status: 'planning-only', reason }`
touching **no seam** — no network, no credential read, no Zoom join. When armed
+ enabled it: signs the join JWT (`meetingSdkJwt`) → `MeetingSdkJoinClient.join`
→ meters the tapped media through the `MediaTapMeter` (#91) seam → republishes to
the WaveTarget's WHIP endpoint via `WhipPublisher`.

The join path is expressed against **injectable seams**. The concrete transports
are a later ◆ — the default `inertJoinClient` / `inertWhipPublisher` THROW if
invoked, so even a mis-armed ON path fails closed rather than reaching a live
meeting. Still not proven live (needs a real meeting + a native headless driver).

### Later ◆ (not in this PR)

- Ship the native headless Zoom Meeting-SDK driver (Linux bot-farm build) behind
  `MeetingSdkJoinClient`, and the real WHIP transport behind `WhipPublisher`.
- Watermark/label the looped source so farm media is self-identifying in the index.
- Wire the real #91 one-subscribe media-tap surface behind `MediaTapMeter`.

## Durability note

The first M2 scaffold was committed locally (`ad339e6`, branch `m2-zoom-inert`)
in an ephemeral worktree and pruned before it was ever pushed — truly lost. This
rebuild is authored against the existing ingress adapter contract and is pushed +
PR'd immediately. See the guard: a local commit is not durable until pushed.
