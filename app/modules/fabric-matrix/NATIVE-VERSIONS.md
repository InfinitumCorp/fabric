# Native SDK pins (Stage 3 spike)

- Android: `org.matrix.rustcomponents:sdk-android:26.10.23` (Apache-2.0 per POM), built from matrix-rust-sdk `8de215a0aa0026afa5754ae5f05a6d168d1a1d60` (release body of matrix-rust-components-kotlin `sdk-v26.10.23`).
- iOS (later): matrix-rust-components-swift `26.10.27` = matrix-rust-sdk `e675036b`, which is 40 commits ahead of the Android pin. The FFI signatures used here (client_builder, store, client login/restore/session/logout) are identical between the two commits; message interoperability is NOT yet tested.
- Store: `SqliteStoreBuilder.key(32 random bytes)`; key wrapped by a non-exportable AndroidKeyStore AES-256-GCM key.
- Gate status: compiles; instrumented tests NOT yet passing (see PR). `encryptedMessaging` stays false.
