"use client";

import { useCallback, useEffect, useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";

type PushState =
  | "loading"
  | "unsupported"
  | "ios-install"
  | "denied"
  | "subscribed"
  | "unsubscribed";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function isIosDevice(): boolean {
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    // iPadOS reports itself as a Mac, but Macs have no touch points.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function PushNotificationsCard({
  userId,
  initialDeviceCount,
}: {
  userId: string;
  initialDeviceCount: number;
}) {
  const [state, setState] = useState<PushState>("loading");
  const [deviceCount, setDeviceCount] = useState(initialDeviceCount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshDeviceCount = useCallback(async () => {
    const supabase = getBrowserClient();
    const { count } = await supabase
      .from("push_subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    if (typeof count === "number") setDeviceCount(count);
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    async function detect() {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        // iOS Safari only exposes Web Push inside an installed (Home Screen) app.
        setState(isIosDevice() && !isStandalone() ? "ios-install" : "unsupported");
        return;
      }
      if (Notification.permission === "denied") {
        setState("denied");
        return;
      }
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (!cancelled) setState(subscription ? "subscribed" : "unsubscribed");
    }
    void detect();
    return () => {
      cancelled = true;
    };
  }, []);

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!vapidKey) {
        throw new Error("Push is not configured (missing NEXT_PUBLIC_VAPID_PUBLIC_KEY).");
      }

      await navigator.serviceWorker.register("/sw.js");
      const registration = await navigator.serviceWorker.ready;

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "unsubscribed");
        return;
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
      const { endpoint, keys } = subscription.toJSON();
      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        throw new Error("Browser returned an incomplete push subscription.");
      }

      // endpoint is unique; RLS hides other users' rows and PostgREST upsert
      // can't be scoped safely here — select-then-write like the other forms.
      const supabase = getBrowserClient();
      const { data: existing, error: selectErr } = await supabase
        .from("push_subscriptions")
        .select("id")
        .eq("endpoint", endpoint)
        .maybeSingle();
      const { error: writeErr } = selectErr
        ? { error: selectErr }
        : existing
          ? await supabase
              .from("push_subscriptions")
              .update({
                p256dh: keys.p256dh,
                auth: keys.auth,
                user_agent: navigator.userAgent,
                last_used_at: new Date().toISOString(),
              })
              .eq("id", existing.id)
          : await supabase.from("push_subscriptions").insert({
              user_id: userId,
              endpoint,
              p256dh: keys.p256dh,
              auth: keys.auth,
              user_agent: navigator.userAgent,
            });
      if (writeErr) throw new Error(writeErr.message);

      setState("subscribed");
      await refreshDeviceCount();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not enable push notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        const supabase = getBrowserClient();
        const { error: deleteErr } = await supabase
          .from("push_subscriptions")
          .delete()
          .eq("endpoint", endpoint);
        if (deleteErr) throw new Error(deleteErr.message);
      }
      setState("unsubscribed");
      await refreshDeviceCount();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disable push notifications.");
    } finally {
      setBusy(false);
    }
  }

  const deviceSummary =
    deviceCount === 1 ? "1 device receives alerts" : `${deviceCount} devices receive alerts`;

  return (
    <section className="rounded-2xl border border-night-600 bg-night-850 p-6">
      <h2 className="text-sm font-semibold text-fog-100">Push notifications on this device</h2>
      <p className="mt-1 text-xs leading-relaxed text-fog-500">
        Get an alert the moment a detection starts, even when Nightjar is closed. {deviceSummary}.
      </p>

      <div className="mt-4">
        {state === "loading" && <p className="text-xs text-fog-500">Checking this device…</p>}

        {state === "unsupported" && (
          <p className="text-xs text-fog-400">
            This browser does not support push notifications.
          </p>
        )}

        {state === "ios-install" && (
          <p className="text-xs leading-relaxed text-fog-400">
            On iPhone and iPad, push notifications require Nightjar to be installed: open the
            Safari share menu and choose{" "}
            <span className="font-medium text-fog-200">Add to Home Screen</span>, then enable
            notifications from the installed app.
          </p>
        )}

        {state === "denied" && (
          <p className="text-xs leading-relaxed text-fog-400">
            Notifications are blocked for this site. Allow them in your browser settings, then
            reload this page.
          </p>
        )}

        {state === "unsubscribed" && (
          <button
            type="button"
            onClick={() => void enable()}
            disabled={busy}
            className="rounded-lg bg-ember-500 px-4 py-2 text-sm font-semibold text-night-950 transition-colors hover:bg-ember-400 disabled:opacity-60"
          >
            {busy ? "Enabling…" : "Enable on this device"}
          </button>
        )}

        {state === "subscribed" && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-full border border-ember-500/40 bg-ember-500/10 px-3 py-1 text-xs font-semibold text-ember-300">
              Enabled on this device
            </span>
            <button
              type="button"
              onClick={() => void disable()}
              disabled={busy}
              className="rounded-lg border border-night-500 px-4 py-2 text-sm font-medium text-fog-300 transition-colors hover:bg-night-800 disabled:opacity-60"
            >
              {busy ? "Disabling…" : "Disable"}
            </button>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
