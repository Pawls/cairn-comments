## ih38
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:06:45Z pos=before decl=isNewer node=028960d7 -->
Prerelease and build metadata are dropped from the version itself, so `1.0.0-beta` compares as
`1.0.0`; only `build`, a bundle timestamp, orders two builds of one version.

## rojd
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:06:47Z pos=before decl=pendingInstall node=1b721c5d -->
`init` asks this before it records a path, so it never records a home that is not this CLI's newest
copy (packages/cli/src/init.ts).
