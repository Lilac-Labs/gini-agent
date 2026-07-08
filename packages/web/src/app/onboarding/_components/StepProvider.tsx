"use client";

import { ProviderPicker } from "@/components/ProviderPicker";
import { serif } from "./bits";

// Capability-derived provider step (ADR web-onboarding-flow.md): shown only
// when the deployment is self-hosted AND no model provider is configured
// (needsProviderStep in ./lib). It sits between sign-in and the wizard proper
// because the Gmail profile scan — kicked off before the welcome step — needs
// the model; managed deployments provision the provider at the platform and
// never see this step (ADR managed-deployment-mode.md). Like sign-in it is a
// prerequisite gate, not one of the dotted product steps. The body is the
// shared ProviderPicker (the exact surface /setup renders), so the catalog,
// per-provider config forms, and POST /api/setup/provider behavior are all
// inherited. "Skip for now" is the step's own footer — NOT the picker's
// secondaryAction slot, which only renders once the catalog has loaded — so
// a user without a key (or with the catalog erroring) can always move on;
// the profile step then degrades to its connect-a-model state instead of
// running a scan that could only fail.
export function StepProvider({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  return (
    <div className="flex flex-col gap-6 px-6 pb-8 pt-10 sm:px-8">
      <header className="flex flex-col gap-2 text-center">
        <h1 className={`${serif} text-[27px]/[32px] font-medium`}>Connect a model</h1>
        <p className="mx-auto max-w-md text-[15px]/[22px] text-[#6B6B66]">
          Gini thinks with a language model you bring. Pick a provider to power your
          assistant — you can change it anytime in Settings.
        </p>
      </header>
      <ProviderPicker submitLabel="Save and continue" pendingLabel="Saving…" onSaved={onDone} />
      <div className="flex justify-center">
        <button
          type="button"
          onClick={onSkip}
          className="text-[13px] text-[#9A9A94] transition-colors hover:text-[#6B6B66] hover:underline"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}
