// FIRM Suite block for the FabriC++ app (React Native). White/black, hairlines, no shadows.
import React from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "./core/theme";
import { FAB_TOKEN, FIRM_TOKEN, firmLinks, shortAddress, type FirmState } from "./core/firm";

export function FirmSuite({ state = { kind: "early" } }: { state?: FirmState }) {
  const links = firmLinks("fabric");
  return (
    <View style={styles.card} accessibilityLabel="FIRM Suite">
      <View style={styles.head}>
        <Text style={styles.wordmark}>
          FIRM Wallet<Text style={styles.tm}>™</Text>
        </Text>
        <Text style={styles.tag}>{state.kind === "wallet" ? "PREVIEW" : "COMING SOON"}</Text>
      </View>
      {state.kind === "wallet" ? (
        <>
          <Text style={styles.sub}>Included with your Cumulus://ID · {shortAddress(state.wallet.address)}</Text>
          <View style={styles.balances}>
            {Object.entries(state.wallet.balances).map(([asset, amount]) => (
              <Text key={asset} style={styles.balance}>
                {amount} <Text style={styles.sub}>${asset}</Text>
              </Text>
            ))}
          </View>
        </>
      ) : (
        <Text style={styles.sub}>Self-custody for Solana, Ethereum and Base. Early access is open.</Text>
      )}
      {[
        [FAB_TOKEN.ticker, theme.name, FAB_TOKEN.network],
        [FIRM_TOKEN.ticker, "Settles every Infinitum product", FIRM_TOKEN.network],
      ].map(([ticker, label, network]) => (
        <View key={ticker} style={styles.row}>
          <Text style={styles.ticker}>{ticker}</Text>
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.muted}>{network}</Text>
        </View>
      ))}
      <View style={styles.actions}>
        <Pressable accessibilityRole="link" style={[styles.btn, styles.solid]} onPress={() => Linking.openURL(links.wallet)}>
          <Text style={styles.solidText}>{state.kind === "wallet" ? "Open FIRM Wallet™" : "Get early access"}</Text>
        </Pressable>
        <Pressable accessibilityRole="link" style={styles.btn} onPress={() => Linking.openURL(links.network)}>
          <Text style={styles.btnText}>Firmament Network™ CPO ↗</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: theme.line, backgroundColor: theme.paper, padding: 16, gap: 12, alignSelf: "stretch" },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  wordmark: { fontSize: 16, color: theme.ink, fontWeight: "400" },
  tm: { fontSize: 9 },
  tag: { fontSize: 11, letterSpacing: 1.2, color: theme.muted },
  sub: { fontSize: 13, color: theme.muted },
  balances: { flexDirection: "row", flexWrap: "wrap", gap: 20 },
  balance: { fontSize: 22, color: theme.ink },
  row: { flexDirection: "row", gap: 12, borderTopWidth: 1, borderTopColor: theme.line, paddingTop: 8 },
  ticker: { width: 64, fontSize: 13, color: theme.ink, fontFamily: "monospace" },
  label: { flex: 1, fontSize: 13, color: theme.ink },
  muted: { fontSize: 13, color: theme.muted },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  btn: { borderWidth: 1, borderColor: theme.ink, height: 36, paddingHorizontal: 14, justifyContent: "center" },
  solid: { backgroundColor: theme.ink },
  solidText: { color: theme.paper, fontSize: 13 },
  btnText: { color: theme.ink, fontSize: 13 },
});
