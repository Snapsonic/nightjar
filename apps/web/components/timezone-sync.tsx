"use client";

import { useEffect } from "react";
import { getBrowserClient } from "@/lib/supabase/client";

/**
 * Records the browser's IANA timezone on the profile once per session, so
 * alerts can be timestamped in the reader's own zone instead of UTC. Silent
 * and best-effort — a failure here must never affect the dashboard.
 */
export function TimezoneSync({ userId, current }: { userId: string; current: string | null }) {
  useEffect(() => {
    let zone: string | undefined;
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return;
    }
    if (!zone || zone === current) return;
    void getBrowserClient().from("profiles").update({ timezone: zone }).eq("id", userId);
  }, [userId, current]);

  return null;
}
