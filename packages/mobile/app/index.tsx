import { Redirect } from "expo-router";
import { View } from "react-native";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";

// Auth gate. The root layout has already primed the AsyncStorage caches by the
// time this component renders, so the redirect is synchronous from the user's
// perspective. Presence of stored gateway credentials is the whole gate.
export default function Index() {
  const { status, credentials } = useAuth();
  if (status === "loading") {
    // Solid surface during the (effectively zero-length) loading window keeps
    // the cold-start visual consistent while primeCredentials() resolves.
    return <View style={{ flex: 1, backgroundColor: theme.bg }} />;
  }
  if (!credentials) {
    return <Redirect href="/setup" />;
  }
  return <Redirect href="/channels" />;
}
