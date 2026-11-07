# FabriC++

Private repository for the FabriC++ mobile app (Android and iPhone), following //RULES// rule 5: one private repo per build.

- Design spec and implementation plans: `InfinitumCorp/infinitum-nexus` PR #23, `docs/superpowers/specs/2026-11-07-fabric-mobile-design.md` and `docs/superpowers/plans/2026-11-07-fabric-*.md`.
- Android messaging uses the Matrix Rust SDK (Apache-2.0), a native Kotlin bridge, and a self-hosted Synapse (AGPL-3.0-or-later or Element commercial licence). The local development server is in `server/`; no production Matrix deployment is configured here.
- Android app: `cd app && npm ci && npm run android:apk`. This builds a private ARM64 test APK with bundled JavaScript. See [toolchain requirements and verification status](docs/android-build-status.md).
- iOS and the remaining live-service gates are described in [the Android implementation plan](docs/stage5-android-plan.md).

No licence file has been added. Infinitum Corporation has not chosen a licence for this repository.
