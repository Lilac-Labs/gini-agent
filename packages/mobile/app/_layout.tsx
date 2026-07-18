import {
  HankenGrotesk_400Regular,
  HankenGrotesk_500Medium,
  HankenGrotesk_600SemiBold,
  HankenGrotesk_700Bold
} from "@expo-google-fonts/hanken-grotesk";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_700Bold
} from "@expo-google-fonts/inter";
import { JetBrainsMono_400Regular } from "@expo-google-fonts/jetbrains-mono";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient
} from "@tanstack/react-query";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { mirrorCachedCredentialsToSharedContainer, primeCredentials, useAuth } from "@/src/auth";
import { LinkContextMenuHost } from "@/src/components/chat/linkContextMenu";
import { FilePreviewProvider } from "@/src/components/FilePreview";
import { ImagePreviewProvider } from "@/src/components/ImagePreview";
import {
  installNotificationResponseListener,
  primeDeviceTokenFromStorage,
  refreshBadge,
  registerApprovalCategoryAsync
} from "@/src/push";
import { family, theme } from "@/src/theme";

// Single shared client across the tree so navigating between screens
// keeps caches warm. Built once per app lifetime — Expo Router never
// remounts _layout outside of a full reload.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Polling on every screen is the primary freshness signal; aggressive
      // refetch-on-mount just doubles the request rate when the user taps
      // back from chat detail to the list.
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      retry: 1
    }
  }
});

export default function RootLayout() {
  // Prime the AsyncStorage credentials cache once before the first child
  // render. Without this, the auth gate in `app/index.tsx` would briefly
  // see `credentials: null` and bounce the user to the signed-out screen
  // even if they were already authed — bad UX on every cold start.
  const [primed, setPrimed] = useState(false);
  useEffect(() => {
    let active = true;
    // Sequence the cold-start primes so by the time AuthCacheGuard
    // fires its first refreshBadge() the X-Device-Token header is
    // already in place AND the APPROVAL_REQUEST notification category
    // exists. Without the device-token prime, /badge and /read would
    // 400 (missing header) for the brief window between credential
    // rehydration and registerForPushAsync() completing. Without the
    // category await, an immediate-on-launch approval push could land
    // before iOS has the Approve / Deny buttons wired.
    // registerApprovalCategoryAsync is iOS-gated and idempotent — the
    // promise it returns is cached at module scope so awaiting it
    // here doesn't race the implicit invocation inside
    // registerForPushAsync.
    (async () => {
      await primeCredentials();
      await primeDeviceTokenFromStorage();
      // Device token is primed now, so mirror the rehydrated credentials
      // (with that token folded in) into the App Group container — an
      // already-signed-in user who relaunches without opening a chat would
      // otherwise leave the NSE with no creds to enrich previews.
      mirrorCachedCredentialsToSharedContainer();
      await registerApprovalCategoryAsync();
      // Install the live tap / action listener at root so a tap that arrives
      // while the app is suspended routes even when the user never opened a
      // chat detail this process (chat detail is the only other caller, via
      // registerForPushAsync). Idempotent + permission-free, so it's safe to
      // call on every launch alongside the category registration.
      installNotificationResponseListener();
      if (active) setPrimed(true);
    })();
    return () => {
      active = false;
    };
  }, []);

  // Load all custom font faces up front. `useFonts` from `expo-font` keys
  // each TTF by the face name we want to reference in `fontFamily` styles;
  // the `family()` helper in theme.ts is the single source of truth for
  // those names. The promise resolves on first run after Expo downloads
  // and caches the files locally — subsequent launches are instant.
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_700Bold,
    HankenGrotesk_400Regular,
    HankenGrotesk_500Medium,
    HankenGrotesk_600SemiBold,
    HankenGrotesk_700Bold,
    JetBrainsMono_400Regular
  });

  // Light palette is the only theme — pin the header chrome to white +
  // dark text and use Hanken Grotesk for the screen title font so the
  // native stack header matches the rest of the chat surfaces.
  const screenOptions = useMemo(
    () => ({
      headerStyle: { backgroundColor: theme.bg } as const,
      headerTitleStyle: {
        color: theme.text,
        fontFamily: family("HankenGrotesk", 700)
      } as const,
      headerTintColor: theme.text,
      contentStyle: { backgroundColor: theme.bg } as const
    }),
    []
  );

  // Hold the first render until both AsyncStorage and the font files are
  // ready. Blank white surface (no spinner) keeps the cold-start visual
  // quiet — the wait should be ≤500ms once the TTFs are cached on disk.
  if (!primed || !fontsLoaded) {
    return <View style={{ flex: 1, backgroundColor: theme.bg }} />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthCacheGuard />
          {/* Light theme — status bar text needs to be dark so it reads
              against the white header chrome. */}
          <StatusBar style="dark" />
          <ImagePreviewProvider>
            <FilePreviewProvider>
              <Stack screenOptions={screenOptions}>
                <Stack.Screen name="index" options={{ headerShown: false }} />
                <Stack.Screen name="setup" options={{ title: "Connect to Gini" }} />
                {/* channels.tsx (the Channels home) draws its own header
                    with the brand title, inbox icon, and compose button. */}
                <Stack.Screen name="channels" options={{ headerShown: false }} />
                <Stack.Screen name="settings" options={{ title: "Settings" }} />
                {/* Chat detail draws its own header (back arrow + agent
                    header + tab bar). Topics open the same screen. */}
                <Stack.Screen
                  name="chat/[sessionId]"
                  options={{ headerShown: false }}
                />
              </Stack>
            </FilePreviewProvider>
          </ImagePreviewProvider>
          {/* Single overlay host for the markdown link long-press menu;
              summoned from the module-level render rules via an emitter.
              Mounted last so its absolute-fill overlay sits above the
              navigator. */}
          <LinkContextMenuHost />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// Drop every cached query when the gateway identity changes. Sign-out
// and switching to a different gateway both broadcast through useAuth,
// so this single effect keeps stale data from leaking across
// credential boundaries without baking baseUrl/token into every query
// key.

function AuthCacheGuard() {
  const { credentials } = useAuth();
  const qc = useQueryClient();
  const prevKeyRef = useRef<string | null | undefined>(undefined);
  // Compose a stable identity from baseUrl + token so a token rotation
  // against the same gateway also evicts stale auth-tied data.
  const identity = credentials
    ? `${credentials.baseUrl}|${credentials.token}`
    : null;

  useEffect(() => {
    const prev = prevKeyRef.current;
    if (prev !== undefined && prev !== identity) {
      qc.clear();
    }
    prevKeyRef.current = identity;
    // Sync the app icon badge once per (newly-authed) identity. The
    // gateway computes the unread total from chat_read_state across
    // every session for the credential, so a cold launch that opened
    // signed-out picks up everything that arrived while the
    // app was killed. Subsequent badge updates ride on silent pushes
    // (push.ts:refreshBadge in the receive handler) and on chat-detail
    // mount.
    if (identity) {
      void refreshBadge();
    }
  }, [identity, qc]);

  return null;
}
