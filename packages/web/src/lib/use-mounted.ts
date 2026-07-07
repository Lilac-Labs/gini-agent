import { useSyncExternalStore } from "react";

// Hydration-safe mounted flag (the Sidebar idiom): the server snapshot is
// `false` and the client snapshot flips to `true` on the first client render,
// so timezone/locale-dependent output (`new Date()` formatting) never
// mismatches the SSR markup.
export function useMounted(): boolean {
  return useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false
  );
}
