import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  DisplayNameForm,
  NotificationChannels,
  NotificationToggles,
  PlanCard,
  SignOutButton,
} from "@/components/settings-forms";
import { PushNotificationsCard } from "@/components/push-settings";
import { createClient } from "@/lib/supabase/server";
import { parseChannels, toPlan } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Settings — Nightjar",
};

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [profileRes, subscriptionRes, notificationRes, pushCountRes] = await Promise.all([
    supabase
      .from("profiles")
      .select("display_name, notify_email, notify_phone")
      .eq("id", user.id)
      .maybeSingle(),
    supabase.from("subscriptions").select("plan, status").eq("owner_id", user.id).maybeSingle(),
    supabase
      .from("notification_settings")
      .select("kinds, channels")
      .eq("user_id", user.id)
      .is("camera_id", null)
      .maybeSingle(),
    supabase
      .from("push_subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id),
  ]);

  const firstError = profileRes.error ?? subscriptionRes.error ?? notificationRes.error;
  if (firstError) {
    return (
      <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
        Could not load your settings: {firstError.message}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-semibold tracking-tight text-fog-100">Settings</h1>

      <div className="mt-6 space-y-6">
        <section className="rounded-2xl border border-night-600 bg-night-850 p-6">
          <h2 className="text-sm font-semibold text-fog-100">Profile</h2>
          <p className="mt-1 text-xs text-fog-500">{user.email}</p>
          <div className="mt-4">
            <DisplayNameForm
              userId={user.id}
              initialDisplayName={profileRes.data?.display_name ?? ""}
            />
          </div>
        </section>

        <PlanCard plan={toPlan(subscriptionRes.data?.plan ?? "free")} />

        <section className="rounded-2xl border border-night-600 bg-night-850 p-6">
          <h2 className="text-sm font-semibold text-fog-100">Notifications</h2>
          <p className="mt-1 text-xs leading-relaxed text-fog-500">
            Choose which detections notify you, across all cameras.
          </p>
          <div className="mt-4">
            <NotificationToggles
              userId={user.id}
              initialKinds={notificationRes.data?.kinds ?? ["person", "package"]}
            />
          </div>
          <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-fog-400">
            Channels
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-fog-500">
            Where those alerts go. Push, email and SMS share the same detections above.
          </p>
          <div className="mt-3">
            <NotificationChannels
              userId={user.id}
              initialChannels={parseChannels(notificationRes.data?.channels)}
              initialNotifyEmail={profileRes.data?.notify_email ?? ""}
              initialNotifyPhone={profileRes.data?.notify_phone ?? ""}
              accountEmail={user.email ?? ""}
            />
          </div>
        </section>

        <PushNotificationsCard userId={user.id} initialDeviceCount={pushCountRes.count ?? 0} />

        <section className="rounded-2xl border border-night-600 bg-night-850 p-6">
          <h2 className="text-sm font-semibold text-fog-100">Session</h2>
          <p className="mt-1 text-xs text-fog-500">Sign out of Nightjar on this device.</p>
          <div className="mt-4">
            <SignOutButton />
          </div>
        </section>
      </div>
    </div>
  );
}
