"use client";

import {
  CalendarIcon,
  FileTextIcon,
  HardDriveIcon,
  MailIcon,
  PlusIcon,
  TableIcon
} from "lucide-react";
import type { GoogleAccountStatus } from "@runtime/types";
import { useGoogleAccounts } from "@/lib/queries";
import { LightPill, PrimaryPill, serif } from "./bits";
import { accountsPrimaryFirst, primaryAccountId } from "./lib";
import { useConnectGoogleAccount } from "./useConnectGoogleAccount";

// Service chips shown per account, in design order. Only granted services
// render.
const SERVICE_CHIPS: Array<{ service: string; icon: typeof MailIcon; color: string }> = [
  { service: "gmail", icon: MailIcon, color: "text-[#D93025]" },
  { service: "calendar", icon: CalendarIcon, color: "text-[#4285F4]" },
  { service: "drive", icon: HardDriveIcon, color: "text-[#2E9E6B]" },
  { service: "docs", icon: FileTextIcon, color: "text-[#4285F4]" },
  { service: "sheets", icon: TableIcon, color: "text-[#0F9D58]" }
];

// Step 4 — connected Google accounts. The list polls every 5s while this step
// is mounted so a freshly added account shows up on its own. "Add account" is
// a same-tab OAuth round trip in both auth modes (edge's /auth/google/add or
// the gateway's loopback PKCE flow — see useConnectGoogleAccount) that
// returns to this step via /onboarding?step=accounts.
export function StepAccounts({ onDone }: { onDone: () => void }) {
  const accounts = useGoogleAccounts({ refetchInterval: 5_000 });
  const rows = accountsPrimaryFirst(accounts.data ?? []);
  const primaryId = primaryAccountId(rows);
  const add = useConnectGoogleAccount("/onboarding?step=accounts");

  return (
    <>
      <div className="flex flex-col gap-[18px] px-6 pb-6 pt-1 sm:px-8">
        <header className="flex flex-col gap-2">
          <h1 className={`${serif} text-[24px]/[29px] font-semibold sm:text-[26px]/[31px]`}>
            Supercharge your assistant.
          </h1>
          <p className="text-[15px]/[22px] text-[#6B6B66]">
            Connections help your assistant do more work, all optional.
          </p>
        </header>

        {accounts.data === undefined ? (
          // First fetch still in flight (fresh page load — e.g. returning from
          // the OAuth round trip): hold the layout with placeholder rows
          // rather than flashing "no accounts".
          <ul className="flex flex-col gap-2.5" aria-hidden>
            {[0, 1].map((i) => (
              <li key={i} className="h-[72px] animate-pulse rounded-[12px] border border-[#E8E8E1] bg-[#F6F6F1]" />
            ))}
          </ul>
        ) : rows.length > 0 ? (
          <ul className="flex flex-col gap-2.5">
            {rows.map((account) => (
              <AccountRow key={account.id} account={account} primary={account.id === primaryId} />
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-[#9A9A94]">No Google accounts connected yet.</p>
        )}

        <div>
          <LightPill onClick={add.connect} disabled={add.isPending}>
            <PlusIcon className="size-3.5" aria-hidden />
            Add account
          </LightPill>
        </div>
      </div>

      <footer className="flex items-center justify-end border-t border-[#E8E8E1] px-6 py-5 sm:px-8">
        <PrimaryPill onClick={onDone} className="rounded-[12px] px-5 py-3">
          Continue
        </PrimaryPill>
      </footer>
    </>
  );
}

function AccountRow({ account, primary }: { account: GoogleAccountStatus; primary: boolean }) {
  const granted = SERVICE_CHIPS.filter(({ service }) => account.services[service]);
  return (
    <li className="flex items-center gap-3.5 rounded-[12px] border border-[#E8E8E1] bg-white p-4">
      <span
        className="flex size-[38px] shrink-0 items-center justify-center rounded-[10px] border border-[#E8E8E1] bg-white text-[20px] font-bold text-[#4285F4]"
        aria-hidden
      >
        G
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold text-[#1A1A1A]">
          {account.email || account.tag}
        </p>
        <p className="truncate text-[13px] text-[#9A9A94]">
          {primary ? "Primary account" : account.tag}
        </p>
      </div>
      {granted.length > 0 ? (
        <div className="flex shrink-0 items-center gap-[5px]">
          {granted.map(({ service, icon: Icon, color }) => (
            <span
              key={service}
              title={service}
              className="flex size-6 items-center justify-center rounded-[6px] bg-[#F4F4EE]"
            >
              <Icon className={`size-[13px] ${color}`} strokeWidth={2} aria-hidden />
            </span>
          ))}
        </div>
      ) : null}
    </li>
  );
}
