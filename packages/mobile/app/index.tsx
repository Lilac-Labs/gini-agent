import { Redirect } from "expo-router";
import { View } from "react-native";
import { useAuth } from "@/src/auth";
import { EDGE_BASE_URL } from "@/src/oauth-login";
import { theme } from "@/src/theme";

// Auth gate. The root layout has already primed the AsyncStorage caches by the
// time this component renders, so the redirect is synchronous from the user's
// perspective. Presence of stored credentials is the whole gate: signed in →
// the app; signed out → the Google login screen when the build has a hosted
// edge (EXPO_PUBLIC_EDGE_BASE_URL set), otherwise the manual /setup connect
// screen for a self-hosted gateway.
export default function Index() {
  const { status, credentials } = useAuth();
  if (status === "loading") {
    // Solid surface during the (effectively zero-length) loading window keeps
    // the cold-start visual consistent while primeCredentials() resolves.
    return <View style={{ flex: 1, backgroundColor: theme.bg }} />;
  }
  if (!credentials) {
    return <Redirect href={EDGE_BASE_URL ? "/login" : "/setup"} />;
  }
  return <Redirect href="/channels" />;
}
