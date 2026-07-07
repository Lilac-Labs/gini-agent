import { Stack, router } from "expo-router";
import {
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@/src/auth";
import { revokeEdgeSession } from "@/src/oauth-login";
import { family, theme } from "@/src/theme";

export default function SettingsScreen() {
  const { credentials, clear } = useAuth();

  const onSignOut = () => {
    Alert.alert(
      "Sign out?",
      "Stored credentials will be removed from this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: async () => {
            // Revoke the session server-side first (best-effort — an edge
            // deletes the sessions row so the token is dead even if a copy
            // lingers somewhere; a self-hosted gateway has no such endpoint
            // and the call is swallowed), then drop it locally and land on
            // the auth gate, which routes to login or setup by build mode.
            await revokeEdgeSession(credentials);
            await clear();
            router.replace("/");
          }
        }
      ]
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <Stack.Screen options={{ title: "Settings" }} />

      <View style={styles.body}>
        <View style={styles.section}>
          <Text style={styles.label}>Connected to</Text>
          <Text style={styles.value}>{credentials?.baseUrl ?? "—"}</Text>
        </View>

        <TouchableOpacity onPress={onSignOut} style={styles.button}>
          <Text style={styles.buttonText}>Sign out</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  body: { flex: 1, padding: 20 },
  section: { marginBottom: 20 },
  label: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4
  },
  value: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 16
  },
  button: {
    marginTop: 12,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.danger
  },
  buttonText: {
    color: theme.buttonText,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 16
  }
});
