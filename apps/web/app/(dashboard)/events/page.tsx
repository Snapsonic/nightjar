import type { Metadata } from "next";
import { EventsFeed } from "@/components/events-feed";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Events — Nightjar",
};

export default async function EventsPage() {
  const supabase = await createClient();
  const { data: cameras, error } = await supabase
    .from("cameras")
    .select("id, name")
    .order("name", { ascending: true });

  if (error) {
    return (
      <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
        Could not load your cameras: {error.message}
      </div>
    );
  }

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight text-fog-100">Events</h1>
      <div className="mt-5">
        <EventsFeed cameras={cameras ?? []} />
      </div>
    </>
  );
}
