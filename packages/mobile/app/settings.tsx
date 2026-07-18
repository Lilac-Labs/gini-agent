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
import { family, theme } from "@/src/theme";

export default function SettingsScreen() {
  const { credentials, clear } = useAuth();

  const onClear = () => {
    Alert.alert(
      "Sign out?",
      "Stored URL and token will be removed from this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: async () => {
            await clear();
            router.replace("/setup");
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
          <Text style={styles.label}>Base URL</Text>
          <Text style={styles.value}>{credentials?.baseUrl ?? "—"}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Token</Text>
          <Text style={styles.value} numberOfLines={1}>
            {credentials?.token ? maskToken(credentials.token) : "—"}
          </Text>
        </View>

        <TouchableOpacity onPress={onClear} style={styles.button}>
          <Text style={styles.buttonText}>Sign out</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function maskToken(token: string): string {
  if (token.length <= 12) return "•".repeat(token.length);
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
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
