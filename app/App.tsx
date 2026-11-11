import React from "react";
import { ActivityIndicator, Pressable, View, Text, StyleSheet } from "react-native";
import { theme } from "./src/core/theme";
import { displayName } from "./src/core/cid";
import { FirmSuite } from "./src/FirmSuite";
import { CumulusIdSignIn, useCumulusId } from "./src/CumulusIdSignIn";

export default function App() {
  const cid = useCumulusId();
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{theme.name}</Text>
      <Text style={styles.subtitle}>End-to-end encrypted messaging</Text>
      <View style={styles.firm}>
        {!cid.ready ? (
          <ActivityIndicator color={theme.ink} />
        ) : cid.session ? (
          <>
            <View style={styles.who}>
              <Text style={styles.whoText} numberOfLines={1}>
                Signed in with Cumulus ID as {displayName(cid.session.profile)}
              </Text>
              <Pressable accessibilityRole="button" onPress={cid.signOut}>
                <Text style={styles.link}>Sign out</Text>
              </Pressable>
            </View>
            <FirmSuite />
          </>
        ) : (
          <CumulusIdSignIn onSignedIn={cid.setSession} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.paper,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  firm: {
    marginTop: 32,
    alignSelf: "stretch",
    maxWidth: 560,
  },
  title: {
    fontSize: 32,
    fontWeight: "400",
    color: theme.ink,
    fontFamily: theme.font,
  },
  subtitle: {
    fontSize: 16,
    color: theme.muted,
    marginTop: 8,
  },
  who: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
  },
  whoText: { flex: 1, fontSize: 13, color: theme.muted },
  link: { fontSize: 13, color: theme.accent },
});
