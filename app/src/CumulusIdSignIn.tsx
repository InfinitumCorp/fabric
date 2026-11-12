// "Sign in with Cumulus ID" for the FabriC++ React Native app. White/black, hairlines, no shadows.
// Opens the Cumulus://ID OIDC issuer in an auth session (Custom Tab / ASWebAuthenticationSession)
// with PKCE S256 and a nonce; the IdP returns to https://infinitumfabric.app/cid/rn, which hands code
// and state to infinitumfabric-app://cid/return. The ID token is verified against the issuer's JWKS
// (ES256, iss, aud, exp, nonce) before the session is kept; the person is keyed by its sub.
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { theme } from "./core/theme";
import {
  CID_APP_RETURN,
  CID_CLIENT,
  authorizeUrl,
  base64url,
  cidEndpoints,
  cidIssuer,
  isLive,
  parseReturn,
  sessionFrom,
  tokenRequestBody,
  tokenResponse,
  verifyIdToken,
  type CidSession,
} from "./core/cid";
import { verifyEs256 } from "./es256";

const KEY = "cumulus-id.session";
const ISSUER = cidIssuer(process.env.EXPO_PUBLIC_CID_ISSUER);

WebBrowser.maybeCompleteAuthSession();

const bytesToBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function loadSession(): Promise<CidSession | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    const s = raw ? (JSON.parse(raw) as CidSession) : null;
    if (isLive(s)) return s;
    if (raw) await SecureStore.deleteItemAsync(KEY);
  } catch {
    // Unreadable store: treat as signed out.
  }
  return null;
}

/** Runs the whole sign-in. Resolves to a session, or null when the person closed the browser. */
async function runSignIn(create: boolean): Promise<CidSession | null> {
  const verifier = base64url(bytesToBase64(Crypto.getRandomBytes(48)));
  const state = base64url(bytesToBase64(Crypto.getRandomBytes(16)));
  const nonce = base64url(bytesToBase64(Crypto.getRandomBytes(16)));
  const challenge = base64url(
    await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 }),
  );
  const pending = { verifier, state, nonce, issuer: ISSUER };
  const url = authorizeUrl(pending, challenge, create);
  const result = await WebBrowser.openAuthSessionAsync(url, CID_APP_RETURN);
  if (result.type !== "success") return null;
  const back = parseReturn(result.url);
  if (!back || back.error) throw new Error("Cumulus ID sign-in was not completed.");
  if (back.state !== state || !back.code) throw new Error("That sign-in did not match. Please try again.");
  const endpoints = cidEndpoints(ISSUER);
  const res = await fetch(endpoints.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: tokenRequestBody(pending, back.code),
  });
  const token = tokenResponse(res.status, await res.json().catch(() => ({})));
  const jwks = await fetch(endpoints.jwks, { headers: { Accept: "application/json" } })
    .then((r) => r.json())
    .catch(() => ({}));
  const keys = Array.isArray((jwks as { keys?: unknown }).keys) ? (jwks as { keys: [] }).keys : [];
  const claims = await verifyIdToken(token.idToken, { issuer: ISSUER, nonce, keys, verify: verifyEs256 });
  const session = sessionFrom(token, claims);
  await SecureStore.setItemAsync(KEY, JSON.stringify(session));
  return session;
}

async function endSession(session: CidSession) {
  await SecureStore.deleteItemAsync(KEY).catch(() => undefined);
  // Revoke at Cumulus://ID so this app session leaves the person's session list.
  fetch(cidEndpoints(ISSUER).revoke, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: session.token, client_id: CID_CLIENT }).toString(),
  }).catch(() => undefined);
}

/** Restores the saved session. `ready` is false until the secure store has been read. */
export function useCumulusId() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<CidSession | null>(null);
  useEffect(() => {
    loadSession().then((s) => {
      setSession(s);
      setReady(true);
    });
  }, []);
  const signOut = useCallback(async () => {
    if (session) await endSession(session);
    setSession(null);
  }, [session]);
  return { ready, session, setSession, signOut };
}

export function CumulusIdSignIn({ onSignedIn }: { onSignedIn: (s: CidSession) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const start = async (create: boolean) => {
    setBusy(true);
    setError("");
    try {
      const s = await runSignIn(create);
      if (s) onSignedIn(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.card} accessibilityLabel="Sign in">
      <Text style={styles.heading}>Sign in</Text>
      <Text style={styles.sub}>FabriC++ signs you in with your Cumulus ID. No password is stored in the app.</Text>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => start(false)} style={[styles.btn, styles.primary]}>
        <Text style={styles.primaryText}>Sign in with Cumulus ID</Text>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => start(true)} style={styles.btn}>
        <Text style={styles.btnText}>Create a Cumulus ID</Text>
      </Pressable>
      <Text style={styles.sub}>No Cumulus ID yet? Create one in the same step. You come back here signed in.</Text>
      {busy ? <ActivityIndicator color={theme.ink} /> : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { alignSelf: "stretch", borderTopWidth: 1, borderColor: theme.line, paddingTop: 16, gap: 12 },
  heading: { fontSize: 18, color: theme.ink },
  sub: { fontSize: 13, color: theme.muted },
  btn: { minHeight: 44, borderWidth: 1, borderColor: theme.ink, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  primary: { backgroundColor: theme.accent, borderColor: theme.accent },
  primaryText: { color: theme.paper, fontSize: 15 },
  btnText: { color: theme.ink, fontSize: 15 },
  error: { color: "#b3261e", fontSize: 13 },
});
