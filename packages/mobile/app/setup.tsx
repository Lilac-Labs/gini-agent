import { Stack, router } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, ApiError } from "@/src/api";
import { normalizeBaseUrl, saveCredentials } from "@/src/auth";
import { family, theme } from "@/src/theme";
import type { RuntimeStatus } from "@/src/types";

const DEFAULT_BASE_URL = "http://localhost:7421";

export default function SetupScreen() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    const trimmedToken = token.trim();
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeBaseUrl(baseUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid base URL.");
      return;
    }
    if (!trimmedToken) {
      setError("Bearer token is required.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // Validate before persisting — saving an unreachable URL would
      // strand the user on a "broken" agents screen with no easy way
      // back without nuking storage.
      await api<RuntimeStatus>("/status", {
        auth: { baseUrl: normalizedUrl, token: trimmedToken }
      });
      await saveCredentials({ baseUrl: normalizedUrl, token: trimmedToken });
      router.replace("/channels");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setError("Token rejected by gateway (401). Double-check the token.");
      } else if (e instanceof Error) {
        setError(e.message);
      } else {
        setError("Unknown error reaching gateway.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <Stack.Screen options={{ title: "Connect to Gini" }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <Image
            source={require("../assets/icon.png")}
            style={styles.logo}
            accessibilityLabel="Gini"
          />
          <Text style={styles.heading}>Connect to Gini</Text>
          <Text style={styles.subhead}>
            Paste the runtime's base URL and bearer token. You can find the
            token in {`~/.gini/instances/<instance>/config.json`} or by running{" "}
            <Text style={styles.mono}>gini status</Text>.
          </Text>

          <Text style={styles.label}>Base URL</Text>
          <TextInput
            value={baseUrl}
            onChangeText={setBaseUrl}
            autoCapitalize="none"
            autoCorrect={false}
            inputMode="url"
            keyboardType="url"
            placeholder={DEFAULT_BASE_URL}
            placeholderTextColor={theme.placeholder}
            editable={!busy}
            style={styles.input}
          />

          <Text style={styles.label}>Bearer token</Text>
          <TextInput
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            placeholder="paste token"
            placeholderTextColor={theme.placeholder}
            editable={!busy}
            style={styles.input}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TouchableOpacity
            disabled={busy}
            onPress={onSubmit}
            style={[styles.button, busy && { backgroundColor: theme.buttonDisabled }]}
          >
            {busy ? (
              <ActivityIndicator color={theme.buttonText} />
            ) : (
              <Text style={styles.buttonText}>Save & continue</Text>
            )}
          </TouchableOpacity>

          <Text style={styles.footnote}>
            On a real device, replace localhost with the runtime host's LAN
            IP (e.g. http://192.168.1.42:7421). The simulator/emulator can
            keep localhost.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  flex: { flex: 1 },
  scroll: { padding: 20, paddingTop: 24, gap: 12 },
  logo: {
    width: 64,
    height: 64,
    alignSelf: "flex-start",
    marginBottom: 4
  },
  heading: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 24
  },
  subhead: {
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 8
  },
  mono: {
    fontFamily: family("JetBrainsMono"),
    fontSize: 13
  },
  label: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 13,
    marginTop: 12
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 16,
    color: theme.text,
    borderColor: theme.inputBorder,
    backgroundColor: theme.bg
  },
  error: {
    color: theme.danger,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14,
    marginTop: 4
  },
  button: {
    marginTop: 20,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.button
  },
  buttonText: {
    color: theme.buttonText,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 16
  },
  footnote: {
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 12,
    lineHeight: 18,
    marginTop: 16
  }
});
