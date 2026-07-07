import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { TextInputProps } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/src/api";
import { useSetupRequests } from "@/src/queries";
import { family, theme } from "@/src/theme";
import type { SetupRequestedBlock } from "@/src/types";

// Query keys invalidated after a Confirm/Cancel — the web set
// (["setup-requests","approvals","tasks","task","chat","events","audit"])
// intersected with the keys the mobile app actually registers, plus "chats"
// (the per-agent list) so the chat row preview refreshes once the turn resumes.
const CONFIRMATION_INVALIDATE_KEYS = [
  "setup-requests",
  "chat",
  "chats",
  "unread"
] as const;

// SetupRequest bubble: user-actor gate. No risk pill — the rule is
// structural per docs/adr/authorization-vs-setup-request.md.
//
// confirmation.request, chat.choice, and browser.fill_secret are interactive
// on mobile, mirroring the web cards (see docs/adr/user-confirmation-primitive.md
// and docs/adr/user-choice-prompt.md): the agent pauses for a user decision /
// credential and the user resolves it here. Every OTHER action
// (connector.request, browser.connect, messaging.*) stays read-only — those
// flows are driven from the web client / Gini on the Mac.
export function BlockSetupRequested({
  block
}: {
  block: SetupRequestedBlock;
}) {
  if (block.action === "confirmation.request") {
    return <ConfirmationCard block={block} />;
  }
  if (block.action === "chat.choice") {
    return <ChoiceCard block={block} />;
  }
  if (block.action === "browser.fill_secret") {
    return <FillSecretCard block={block} />;
  }
  return <ReadOnlyCard block={block} />;
}

function ReadOnlyCard({ block }: { block: SetupRequestedBlock }) {
  const isConnectorRequest = block.action === "connector.request";
  // browser.connect covers both sign-in and handoff (payment entry, final
  // confirmation) uses, and the block carries no payload to tell them
  // apart — so the copy stays mode-neutral.
  const title =
    block.action === "browser.connect"
      ? "Browser action needed"
      : isConnectorRequest
        ? "Connection setup needed"
        : block.action;
  const hint =
    isConnectorRequest
      ? "Finish this setup in Gini on your Mac. This chat is paused until the connection is completed or the turn is stopped."
      : block.action === "browser.connect"
        ? "Finish this step from Gini on your Mac. This chat is paused until setup is completed or the turn is stopped."
        : "Open Gini on your Mac to continue, or stop this turn from the composer.";
  return (
    <View style={styles.row}>
      <View style={styles.header}>
        <Text style={styles.action}>{title}</Text>
      </View>
      {/* connector.request repeats the model's reason as a separate
          assistant bubble, so skip the duplicate here. */}
      {!isConnectorRequest ? <Text style={styles.summary}>{block.summary}</Text> : null}
      <Text style={styles.hint}>{hint}</Text>
    </View>
  );
}

// Interactive Confirm/Cancel card. Confirm POSTs an empty body to
// /complete (resumes the loop with {confirmed:true}); Cancel POSTs to
// /cancel ({confirmed:false}). The trusted details + confirm label come
// from the setup payload the dispatcher minted (the block carries only the
// summary). When the request resolves (status !== "pending") the buttons
// give way to a past-tense outcome line.
function ConfirmationCard({ block }: { block: SetupRequestedBlock }) {
  const qc = useQueryClient();
  const setupRequests = useSetupRequests();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [inFlight, setInFlight] = useState(false);

  const setup = (setupRequests.data ?? []).find((s) => s.id === block.setupRequestId) ?? null;
  const isPending = setup ? setup.status === "pending" : true;
  const details =
    setup && typeof setup.payload?.details === "string" ? (setup.payload.details as string) : "";
  const confirmLabel =
    setup
    && typeof setup.payload?.confirmLabel === "string"
    && (setup.payload.confirmLabel as string).trim().length > 0
      ? (setup.payload.confirmLabel as string)
      : "Confirm";

  // POST to /complete (confirm) or /cancel (decline); both resume the
  // paused chat task. invalidate refreshes the card out of pending state
  // and bumps the chat surface so the resumed turn renders promptly. The
  // in-flight flag disables both buttons until the request settles.
  const resolve = async (kind: "complete" | "cancel") => {
    if (inFlight || !isPending) return;
    setInFlight(true);
    try {
      await api(`/setup-requests/${block.setupRequestId}/${kind}`, { method: "POST" });
      for (const key of CONFIRMATION_INVALIDATE_KEYS) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    } catch (err) {
      Alert.alert(
        kind === "complete" ? "Confirm failed" : "Cancel failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setInFlight(false);
    }
  };

  const cardStyle = isPending ? [styles.row, styles.pendingCard] : styles.row;

  return (
    <View style={cardStyle}>
      <View style={styles.header}>
        <Text style={styles.action}>Confirmation needed</Text>
      </View>
      <Text style={styles.summary}>{block.summary}</Text>
      {isPending && details ? (
        <View>
          <Pressable onPress={() => setDetailsOpen((v) => !v)} hitSlop={6}>
            <Text style={styles.detailsToggle}>
              {detailsOpen ? "Hide details" : "Review details"}
            </Text>
          </Pressable>
          {detailsOpen ? (
            <View style={styles.detailsBox}>
              <Text style={styles.detailsText}>{details}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {isPending ? (
        <View style={styles.actions}>
          <Pressable
            onPress={() => resolve("complete")}
            disabled={inFlight}
            style={({ pressed }) => [
              styles.confirmButton,
              (pressed || inFlight) && styles.buttonDimmed
            ]}
          >
            <Text style={styles.confirmText}>{confirmLabel}</Text>
          </Pressable>
          <Pressable
            onPress={() => resolve("cancel")}
            disabled={inFlight}
            style={({ pressed }) => [
              styles.cancelButton,
              (pressed || inFlight) && styles.buttonDimmed
            ]}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      ) : (
        // Confirm is a /complete, Cancel a /cancel — so completed = confirmed
        // and cancelled = declined.
        <Text style={styles.outcome}>
          {setup?.status === "completed" ? "Confirmed." : "Cancelled."}
        </Text>
      )}
    </View>
  );
}

type ChoiceOption = { label: string; description?: string };

// Defensive parse of the dispatcher-minted options array (mirrors web
// parseChoiceOptions). The dispatcher already validated shape (2-6 entries,
// non-empty distinct labels); this just narrows the unknown payload and
// drops anything malformed so a bad payload can't crash the renderer.
function parseChoiceOptions(raw: unknown): ChoiceOption[] {
  if (!Array.isArray(raw)) return [];
  const out: ChoiceOption[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { label?: unknown; description?: unknown };
    if (typeof candidate.label !== "string" || candidate.label.length === 0) continue;
    out.push({
      label: candidate.label,
      ...(typeof candidate.description === "string" && candidate.description.length > 0
        ? { description: candidate.description }
        : {})
    });
  }
  return out;
}

// Interactive single-select card for a pending chat.choice (ask_user)
// SetupRequest — mobile's own answer surface for the same /complete and
// /cancel contract the web chat resolves through. The question + options
// come from the TRUSTED setup payload the dispatcher minted (the block
// carries only the summary, which is the question too). The card always
// adds its own "Other (type your answer)" freeform row and a Skip
// affordance (Skip = the /cancel endpoint, which resumes the agent with
// a skip fallback rather than failing the task). Selecting an option clears
// any typed Other text and vice-versa, so exactly one answer is submitted.
// When the request resolves (status !== "pending") the controls give way to
// the chosen answer (completed) or "Skipped." (cancelled).
function ChoiceCard({ block }: { block: SetupRequestedBlock }) {
  const qc = useQueryClient();
  const setupRequests = useSetupRequests();
  const [selected, setSelected] = useState<number | "other" | null>(null);
  const [otherText, setOtherText] = useState("");
  const [inFlight, setInFlight] = useState(false);

  const setup = (setupRequests.data ?? []).find((s) => s.id === block.setupRequestId) ?? null;
  const isPending = setup ? setup.status === "pending" : true;
  const question =
    setup && typeof setup.payload?.question === "string"
      ? (setup.payload.question as string)
      : block.summary;
  const options: ChoiceOption[] = setup ? parseChoiceOptions(setup.payload?.options) : [];

  const ready = selected === "other" ? otherText.trim().length > 0 : selected !== null;

  // Submit posts { choice: { label } } for a listed option or
  // { choice: { other } } for the freeform input; both resume the paused
  // chat task. Skip posts to /cancel. invalidate refreshes the card out of
  // pending state and bumps the chat surface so the resumed turn renders
  // promptly. The in-flight flag disables the controls until the request
  // settles.
  const submit = async () => {
    if (inFlight || !isPending || !ready) return;
    setInFlight(true);
    try {
      const body =
        selected === "other"
          ? { choice: { other: otherText.trim() } }
          : { choice: { label: typeof selected === "number" ? options[selected]?.label : null } };
      await api(`/setup-requests/${block.setupRequestId}/complete`, {
        method: "POST",
        body: JSON.stringify(body)
      });
      for (const key of CONFIRMATION_INVALIDATE_KEYS) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    } catch (err) {
      Alert.alert("Submit failed", err instanceof Error ? err.message : String(err));
    } finally {
      setInFlight(false);
    }
  };

  const skip = async () => {
    if (inFlight || !isPending) return;
    setInFlight(true);
    try {
      await api(`/setup-requests/${block.setupRequestId}/cancel`, { method: "POST" });
      for (const key of CONFIRMATION_INVALIDATE_KEYS) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    } catch (err) {
      Alert.alert("Skip failed", err instanceof Error ? err.message : String(err));
    } finally {
      setInFlight(false);
    }
  };

  if (!isPending) {
    // Completed rows carry the human-readable selection ("You selected: X" /
    // "You answered: ...") as the persisted outcome message; Skip is a
    // /cancel, so cancelled = skipped.
    const answer =
      setup?.status === "completed"
        ? setup.connectOutcome?.message ?? "Answered."
        : "Skipped.";
    return (
      <View style={styles.row}>
        <View style={styles.header}>
          <Text style={styles.action}>Question</Text>
        </View>
        <Text style={styles.summary}>{question}</Text>
        <Text style={styles.outcome}>{answer}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.row, styles.pendingCard]}>
      <View style={styles.header}>
        <Text style={styles.action}>Question</Text>
      </View>
      <Text style={styles.summary}>{question}</Text>
      <View style={styles.optionList}>
        {options.map((option, index) => {
          const active = selected === index;
          return (
            <Pressable
              key={option.label}
              onPress={() => {
                setSelected(index);
                setOtherText("");
              }}
              disabled={inFlight}
              style={[styles.optionRow, active && styles.optionRowActive]}
            >
              <Text style={styles.optionLabel}>{option.label}</Text>
              {option.description ? (
                <Text style={styles.optionDescription}>{option.description}</Text>
              ) : null}
            </Pressable>
          );
        })}
        <Pressable
          onPress={() => setSelected("other")}
          disabled={inFlight}
          style={[styles.optionRow, selected === "other" && styles.optionRowActive]}
        >
          <Text style={styles.optionLabel}>Other (type your answer)</Text>
        </Pressable>
        <TextInput
          value={otherText}
          onChangeText={(text) => {
            setOtherText(text);
            if (text.length > 0) setSelected("other");
          }}
          placeholder="Type your answer"
          placeholderTextColor={theme.muted}
          editable={!inFlight}
          style={styles.otherInput}
          autoCapitalize="sentences"
          autoCorrect
        />
      </View>
      <View style={styles.actions}>
        <Pressable
          onPress={submit}
          disabled={inFlight || !ready}
          style={({ pressed }) => [
            styles.confirmButton,
            (pressed || inFlight || !ready) && styles.buttonDimmed
          ]}
        >
          <Text style={styles.confirmText}>Submit</Text>
        </Pressable>
        <Pressable onPress={skip} disabled={inFlight} hitSlop={6}>
          <Text style={[styles.skipText, inFlight && styles.buttonDimmed]}>Skip</Text>
        </Pressable>
      </View>
    </View>
  );
}

// Mirror of the web parser in web/src/lib/fill-secrets-types.ts (itself a
// mirror of the gateway-side src/execution/browser-fill-secrets-types.ts). The
// kind allowlist MUST match what the gateway dispatch / /complete handler
// enforces, otherwise a malformed approval payload could widen the rendered
// input type past what the gateway permits. If you change the parser or the
// allowlist, update those files together.
type FillSecretSlotKind = "text" | "password" | "email" | "tel" | "number" | "url";

const FILL_SECRET_ALLOWED_KINDS: ReadonlySet<FillSecretSlotKind> = new Set([
  "text",
  "password",
  "email",
  "tel",
  "number",
  "url"
]);

type FillSecretSlot = {
  name: string;
  locator: string;
  label: string;
  kind: FillSecretSlotKind;
};

function parseFillSecretSlots(raw: unknown): FillSecretSlot[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as { name?: unknown; locator?: unknown; label?: unknown; kind?: unknown };
    if (typeof e.name !== "string" || typeof e.locator !== "string") return [];
    const kind: FillSecretSlotKind =
      typeof e.kind === "string" && (FILL_SECRET_ALLOWED_KINDS as ReadonlySet<string>).has(e.kind)
        ? (e.kind as FillSecretSlotKind)
        : "text";
    const label = typeof e.label === "string" ? e.label : e.name;
    return [{ name: e.name, locator: e.locator, label, kind }];
  });
}

// Map a slot kind to RN TextInput keyboard/autocorrect props. Every secret is
// non-autocapitalized and non-autocorrected; the gateway holds the locator, so
// the client only ever submits name → value.
function fillInputProps(kind: FillSecretSlotKind): Partial<TextInputProps> {
  switch (kind) {
    case "password":
      return { secureTextEntry: true, autoCapitalize: "none", autoCorrect: false };
    case "email":
      return { keyboardType: "email-address", autoCapitalize: "none", autoCorrect: false };
    case "tel":
      return { keyboardType: "phone-pad", autoCapitalize: "none", autoCorrect: false };
    case "number":
      return { keyboardType: "number-pad", autoCapitalize: "none", autoCorrect: false };
    case "url":
      return { keyboardType: "url", autoCapitalize: "none", autoCorrect: false };
    default:
      return { autoCapitalize: "none", autoCorrect: false };
  }
}

// Interactive credential-fill card for a pending browser.fill_secret
// SetupRequest, mirroring the web fill_secret path. The slots come from the
// TRUSTED setup payload the dispatcher minted (the block carries only the
// summary); the "Fill destination" badge shows payload.approvedUrl ?? target —
// the gateway-captured, non-spoofable trust anchor the agent cannot rewrite.
// Submit POSTs { secrets: { [name]: value } } to /complete (the gateway pipes
// each value into the live page); Cancel POSTs /cancel. Typed values live only
// in local state and the POST body and are cleared on EVERY termination path so
// a secret never lingers past the click. When the request resolves
// (status !== "pending") the inputs give way to a past-tense outcome line.
function FillSecretCard({ block }: { block: SetupRequestedBlock }) {
  const qc = useQueryClient();
  const setupRequests = useSetupRequests();
  const [fillValues, setFillValues] = useState<Record<string, string>>({});
  const [inFlight, setInFlight] = useState(false);

  const setup = (setupRequests.data ?? []).find((s) => s.id === block.setupRequestId) ?? null;
  const isPending = setup ? setup.status === "pending" : true;
  const slots: FillSecretSlot[] = setup ? parseFillSecretSlots(setup.payload?.slots) : [];
  const destination =
    setup && typeof setup.payload?.approvedUrl === "string"
      ? (setup.payload.approvedUrl as string)
      : setup?.target;

  const ready =
    slots.length > 0
    && slots.every((s) => typeof fillValues[s.name] === "string" && fillValues[s.name].trim().length > 0);

  // Submit pipes the typed values into the live page via /complete; Cancel
  // resumes the paused task with no fill. invalidate refreshes the card out of
  // pending state and bumps the chat surface. The gateway resolves the setup
  // request atomically BEFORE running fills, so always invalidate (on ok and
  // !ok). Typed values are cleared in finally on every path — success, server
  // ok:false, thrown error, cancel — so a secret never lingers in React state
  // past the click.
  const submit = async () => {
    if (inFlight || !isPending || !ready) return;
    setInFlight(true);
    try {
      const result = await api<{ ok: boolean; message?: string }>(
        `/setup-requests/${block.setupRequestId}/complete`,
        { method: "POST", body: JSON.stringify({ secrets: fillValues }) }
      );
      if (result?.ok === false) {
        Alert.alert(
          "Fill failed",
          result.message ?? "Fill failed; the agent will decide whether to retry."
        );
      }
      for (const key of CONFIRMATION_INVALIDATE_KEYS) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    } catch (err) {
      Alert.alert("Submit failed", err instanceof Error ? err.message : String(err));
    } finally {
      setFillValues({});
      setInFlight(false);
    }
  };

  const cancel = async () => {
    if (inFlight || !isPending) return;
    setInFlight(true);
    try {
      await api(`/setup-requests/${block.setupRequestId}/cancel`, { method: "POST" });
      for (const key of CONFIRMATION_INVALIDATE_KEYS) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    } catch (err) {
      Alert.alert("Cancel failed", err instanceof Error ? err.message : String(err));
    } finally {
      setFillValues({});
      setInFlight(false);
    }
  };

  if (!isPending) {
    // Submit is a /complete, Cancel a /cancel — so completed = submitted and
    // cancelled = cancelled (mirrors the web fill_secret displaySummary).
    return (
      <View style={styles.row}>
        <View style={styles.header}>
          <Text style={styles.action}>Credentials needed</Text>
        </View>
        <Text style={styles.summary}>{block.summary}</Text>
        <Text style={styles.outcome}>
          {setup?.status === "completed" ? "Credentials submitted." : "Request cancelled."}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.row, styles.pendingCard]}>
      <View style={styles.header}>
        <Text style={styles.action}>Credentials needed</Text>
      </View>
      <Text style={styles.summary}>{block.summary}</Text>
      {destination ? (
        <View style={styles.destinationBadge}>
          <Text style={styles.destinationLabel}>Fill destination: </Text>
          <Text style={styles.destinationValue}>{destination}</Text>
        </View>
      ) : null}
      <View style={styles.optionList}>
        {slots.map((slot) => (
          <View key={slot.name} style={styles.fillField}>
            <Text style={styles.fillLabel}>{slot.label}</Text>
            <TextInput
              value={fillValues[slot.name] ?? ""}
              onChangeText={(text) => setFillValues((prev) => ({ ...prev, [slot.name]: text }))}
              placeholderTextColor={theme.muted}
              editable={!inFlight}
              style={styles.otherInput}
              {...fillInputProps(slot.kind)}
            />
          </View>
        ))}
      </View>
      <View style={styles.actions}>
        <Pressable
          onPress={submit}
          disabled={inFlight || !ready}
          style={({ pressed }) => [
            styles.confirmButton,
            (pressed || inFlight || !ready) && styles.buttonDimmed
          ]}
        >
          <Text style={styles.confirmText}>Submit</Text>
        </Pressable>
        <Pressable
          onPress={cancel}
          disabled={inFlight}
          style={({ pressed }) => [
            styles.cancelButton,
            (pressed || inFlight) && styles.buttonDimmed
          ]}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignSelf: "stretch",
    backgroundColor: theme.bg,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    gap: 6
  },
  // Amber accent while the confirmation is awaiting the user, matching the
  // pending convention used by the tool-call waiting card and the web setup
  // card.
  pendingCard: {
    borderColor: "rgba(251, 191, 36, 0.4)",
    backgroundColor: "rgba(251, 191, 36, 0.05)"
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  action: {
    color: theme.text,
    fontFamily: family("JetBrainsMono"),
    fontSize: 12,
    flexShrink: 1
  },
  summary: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14,
    lineHeight: 19
  },
  hint: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 12,
    fontStyle: "italic"
  },
  detailsToggle: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12,
    textDecorationLine: "underline"
  },
  detailsBox: {
    marginTop: 6,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    backgroundColor: theme.bg
  },
  detailsText: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 13,
    lineHeight: 18
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 2
  },
  confirmButton: {
    borderRadius: 8,
    backgroundColor: theme.button,
    paddingHorizontal: 16,
    paddingVertical: 8
  },
  confirmText: {
    color: theme.buttonText,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 13
  },
  cancelButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    paddingHorizontal: 16,
    paddingVertical: 8
  },
  cancelText: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 13
  },
  buttonDimmed: {
    opacity: 0.6
  },
  outcome: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 13
  },
  // Amber band echoing the web "Fill destination" badge: the gateway-captured
  // page URL is the only non-spoofable element on the card, so it gets a
  // distinct treatment from the agent-authored labels/summary.
  destinationBadge: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(251, 191, 36, 0.4)",
    backgroundColor: theme.bg,
    marginTop: 2
  },
  destinationLabel: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 11
  },
  destinationValue: {
    color: theme.text,
    fontFamily: family("JetBrainsMono"),
    fontSize: 11,
    flexShrink: 1
  },
  fillField: {
    gap: 4
  },
  fillLabel: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 11
  },
  optionList: {
    gap: 6,
    marginTop: 2
  },
  optionRow: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    backgroundColor: theme.bg,
    gap: 2
  },
  // Selected single-select row — navy accent matching the confirm button
  // (#0A1A3F) so the chosen answer reads as active.
  optionRowActive: {
    borderColor: theme.button,
    backgroundColor: "rgba(10, 26, 63, 0.06)"
  },
  optionLabel: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14,
    lineHeight: 19
  },
  optionDescription: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 12,
    lineHeight: 16
  },
  otherInput: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    backgroundColor: theme.bg
  },
  skipText: {
    marginLeft: "auto",
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12,
    textDecorationLine: "underline"
  }
});
