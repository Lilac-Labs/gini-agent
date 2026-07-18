"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// /routines is the canonical scheduled-jobs surface; this route survives only
// so stale deep links (old chats, history) don't 404. `?job=<id>` lands on the
// canonical per-job page — /routines/job/<id> itself forwards template
// installs to /routines/<templateId>.
export default function JobsRedirect() {
  const router = useRouter();
  const params = useSearchParams();
  const jobId = params?.get("job");

  useEffect(() => {
    router.replace(jobId ? `/routines/job/${encodeURIComponent(jobId)}` : "/routines");
  }, [router, jobId]);

  return null;
}
