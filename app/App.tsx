import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { theme } from "./src/core/theme";

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{theme.name}</Text>
      <Text style={styles.subtitle}>End-to-end encrypted messaging</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.paper,
    alignItems: "center",
    justifyContent: "center",
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
