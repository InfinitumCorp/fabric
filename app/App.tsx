import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { theme } from "./src/core/theme";
import { FirmSuite } from "./src/FirmSuite";

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{theme.name}</Text>
      <Text style={styles.subtitle}>End-to-end encrypted messaging</Text>
      <View style={styles.firm}>
        <FirmSuite />
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
});
