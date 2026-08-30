# wave-conferencing-bridge secrets

No secrets in this repo.

## Runtime (per operator install)

| Secret | Lives where |
|---|---|
| WAVE stream key | Issued by gateway, stored in wave-desktop's safeStorage; never touches this library |
| Zoom OAuth token (for Zoom App SDK ingress flow, future) | Companion `wave-virtual-devices-macos`/`windows`/`linux` Keychain / DPAPI / libsecret |

## Build / release

No secrets. CI uses default `GITHUB_TOKEN` for the foundation gate.

## Public-facing config

`WAVE_RTMP_BASE` defaults to `rtmps://ingest.wave.online/live` — public by
design; the stream key is what carries the auth.


## Machine surface

```yaml secrets-contract
version: "0.1"
secrets: []
deny_paths:
  - ".dev.vars"
  - ".dev.vars.*"
  - ".env"
  - ".env.*"
```
