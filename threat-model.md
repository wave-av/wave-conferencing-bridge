# wave-conferencing-bridge threat model

## Scope

TypeScript library: types + factory functions only. No runtime processes
in this repo; the threat model covers what consumers of the library must
not let slip.

## Trust boundaries

| Boundary | Threat | Defense |
|---|---|---|
| WAVE stream key in `RtmpIngressBinding` | Logging / telemetry leak | Library treats `streamKey` as opaque + structured-log-redacted; library never echoes it. Consumers must do the same |
| Per-platform driver companion repos | Privilege escalation via kernel driver | Out of scope here; each companion repo has its own threat model |
| RTMP transport (`rtmps://` only) | MITM injecting frames | Default base is `rtmps://` (TLS-wrapped); HTTP variant is unsupported by `bindRtmpIngress` |

## Out-of-scope

- Conferencing-app vulnerabilities (third-party)
- Per-platform driver signing / notarization (companion repos)
- Gateway-side auth (gateway repo)

## Process

- Threat model is reviewed at every minor version bump
- New types or factories that touch stream keys MUST update this doc in
  the same PR
