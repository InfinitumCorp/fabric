// Plan and billing for the FabriC++ app (React Native). White/black, hairlines, no shadows.
// Plans come from the Infinitum revenue API (EXPO_PUBLIC_REVENUE_URL). The app never holds a Stripe
// key: it sends the person's Cumulus ID access token and opens the Checkout / portal URL it returns.
// Stripe sends the browser back to https://infinitumfabric.app/billing/rn, which hands the result to
// infinitumfabric-app://billing/return. Hidden on MIL editions (EXPO_PUBLIC_EDITION=mil).
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { theme } from "./core/theme";
import {
  BUSINESS_PLAN,
  billingNotice,
  createRevenueClient,
  formatPrice,
  revenueUrl,
  seatCount,
  type CatalogPlan,
  type FabricPlan,
} from "./core/revenue";

const REVENUE_URL = revenueUrl(process.env.EXPO_PUBLIC_REVENUE_URL);
const RETURN_URL = "https://infinitumfabric.app/billing/rn";
const APP_RETURN = "infinitumfabric-app://billing/return";
export const BILLING_HIDDEN = (process.env.EXPO_PUBLIC_EDITION ?? "").toLowerCase().startsWith("mil");

export function Billing({ token }: { token: string }) {
  const client = useMemo(
    () => createRevenueClient({ baseUrl: REVENUE_URL, token: async () => token, fetch, paymentsEnabled: false }),
    [token],
  );
  const [plans, setPlans] = useState<CatalogPlan[]>([]);
  const [current, setCurrent] = useState<FabricPlan | null>(null);
  const [seats, setSeats] = useState("1");
  const [org, setOrg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    client.catalog().then(setPlans).catch(() => setError("Plans could not be loaded."));
    client
      .fabricPlan()
      .then(setCurrent)
      .catch((e: Error) => setError(e.message));
  }, [client]);
  useEffect(refresh, [refresh]);

  const open = async (key: string, getUrl: () => Promise<string>) => {
    setBusy(key);
    setError("");
    setNotice(null);
    try {
      const result = await WebBrowser.openAuthSessionAsync(await getUrl(), APP_RETURN);
      if (result.type === "success") setNotice(billingNotice(new URL(result.url).search));
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Billing is not available right now.");
    } finally {
      setBusy(null);
    }
  };

  const onBusiness = current?.plan === BUSINESS_PLAN;
  const name = (id: string) => plans.find((p) => p.id === id)?.name ?? id;

  return (
    <View style={styles.card} accessibilityLabel="Plan and billing">
      <Text style={styles.heading}>Plan and billing</Text>
      {current ? (
        <Text style={styles.sub}>
          Current plan: <Text style={styles.ink}>{name(current.plan)}</Text> · {current.status}
          {current.seats > 1 ? ` · ${current.seats} seats` : ""}
        </Text>
      ) : null}
      {plans.map((p) => (
        <View key={p.id} style={styles.row}>
          <Text style={styles.label}>{p.name}</Text>
          <Text style={styles.muted}>{formatPrice(p)}</Text>
        </View>
      ))}
      {!onBusiness ? (
        <>
          <Text style={styles.sub}>FABRIC Business is for organisations. Upgrading turns your account into a business account.</Text>
          <View style={styles.fields}>
            <TextInput
              style={[styles.input, styles.grow]}
              value={org}
              onChangeText={setOrg}
              placeholder="Organisation name"
              placeholderTextColor={theme.muted}
              accessibilityLabel="Organisation name"
            />
            <TextInput
              style={[styles.input, styles.seats]}
              value={seats}
              onChangeText={setSeats}
              keyboardType="number-pad"
              accessibilityLabel="Seats"
            />
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={busy !== null}
            style={[styles.btn, styles.solid]}
            onPress={() => open("upgrade", () => client.upgradeToBusiness(seatCount(seats), RETURN_URL, org))}
          >
            <Text style={styles.solidText}>{busy === "upgrade" ? "Opening checkout…" : "Upgrade to Business"}</Text>
          </Pressable>
        </>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={busy !== null}
        style={styles.btn}
        onPress={() => open("portal", () => client.billingPortal(RETURN_URL))}
      >
        <Text style={styles.btnText}>{busy === "portal" ? "Opening…" : "Manage billing"}</Text>
      </Pressable>
      {busy ? <ActivityIndicator color={theme.ink} /> : null}
      {notice ? <Text style={styles.sub}>{notice}</Text> : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: theme.line, backgroundColor: theme.paper, padding: 16, gap: 12, alignSelf: "stretch", marginBottom: 16 },
  heading: { fontSize: 16, color: theme.ink },
  sub: { fontSize: 13, color: theme.muted },
  ink: { color: theme.ink },
  row: { flexDirection: "row", gap: 12, borderTopWidth: 1, borderTopColor: theme.line, paddingTop: 8 },
  label: { flex: 1, fontSize: 13, color: theme.ink },
  muted: { fontSize: 13, color: theme.muted },
  fields: { flexDirection: "row", gap: 8 },
  input: { borderWidth: 1, borderColor: theme.line, height: 40, paddingHorizontal: 10, color: theme.ink, fontSize: 14 },
  grow: { flex: 1 },
  seats: { width: 72 },
  btn: { borderWidth: 1, borderColor: theme.ink, minHeight: 40, paddingHorizontal: 14, alignItems: "center", justifyContent: "center" },
  solid: { backgroundColor: theme.ink },
  solidText: { color: theme.paper, fontSize: 14 },
  btnText: { color: theme.ink, fontSize: 14 },
  error: { color: "#b3261e", fontSize: 13 },
});
