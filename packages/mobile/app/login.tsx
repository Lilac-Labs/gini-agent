import { Redirect, Stack, router } from "expo-router";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import {
  ActivityIndicator,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { saveCredentials } from "@/src/auth";
import { buildMobileAuthUrl, EDGE_BASE_URL, parseOauthRedirect } from "@/src/oauth-login";
import { family, theme } from "@/src/theme";

// The signed-out landing for edge-fronted builds (EXPO_PUBLIC_EDGE_BASE_URL
// set at build time). Primary action: Continue with Google — the whole OAuth
// dance runs on the edge inside a system auth session; we just capture the
// session token it returns (via the gini://auth redirect) and persist it as
// {baseUrl, token} — the exact shape every other screen already consumes, so
// chat, push, approvals and voice keep working untouched after sign-in.
// Below it, "Connect to your own gateway" opens the manual /setup flow for
// self-hosted gateways. Builds without an edge URL never route here (the auth
// gate goes straight to /setup), so a stray navigation just redirects.
export default function LoginScreen() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const edgeBaseUrl = EDGE_BASE_URL;
  if (!edgeBaseUrl) {
    return <Redirect href="/setup" />;
  }

  const onSignIn = async () => {
    setError(null);
    setBusy(true);
    try {
      // The app's own return URL (gini://auth in a standalone build). iOS uses
      // its scheme as the callback scheme for the auth session; the edge always
      // targets gini://auth server-side, so this only tells the OS what to watch
      // for — a page can't redirect the token anywhere else.
      const returnUrl = Linking.createURL("auth");
      const result = await WebBrowser.openAuthSessionAsync(
        buildMobileAuthUrl(edgeBaseUrl),
        returnUrl
      );
      if (result.type !== "success") {
        // Dismissed / cancelled — stay on the sign-in screen, no error.
        setBusy(false);
        return;
      }
      const token = parseOauthRedirect(result.url);
      if (!token) {
        throw new Error("Sign-in didn't complete. Please try again.");
      }
      // saveCredentials writes AsyncStorage, broadcasts to useAuth, mirrors to
      // the App Group container for the notification extension, and re-arms push
      // registration against the edge — the whole authed app comes online.
      await saveCredentials({ baseUrl: edgeBaseUrl, token });
      router.replace("/channels");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed. Please try again.");
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <Stack.Screen options={{ headerShown: false }} />
      <Image
        source={require("../assets/icon.png")}
        style={styles.logo}
        accessibilityLabel="Gini"
      />
      <Text style={styles.heading}>Gini</Text>
      <Text style={styles.subhead}>The agent that remembers and learns.</Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <TouchableOpacity
        disabled={busy}
        onPress={onSignIn}
        accessibilityRole="button"
        style={[styles.button, busy && { opacity: 0.6 }]}
      >
        {busy ? (
          <ActivityIndicator color={theme.buttonText} />
        ) : (
          <Text style={styles.buttonText}>Continue with Google</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        disabled={busy}
        onPress={() => router.push("/setup")}
        accessibilityRole="link"
      >
        <Text style={styles.link}>Connect to your own gateway</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 12
  },
  logo: { width: 72, height: 72, marginBottom: 8 },
  heading: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 30
  },
  subhead: {
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 15,
    textAlign: "center",
    marginBottom: 20
  },
  error: {
    color: theme.danger,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14,
    textAlign: "center"
  },
  button: {
    alignSelf: "stretch",
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
  link: {
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14,
    marginTop: 8,
    textDecorationLine: "underline"
  }
});
