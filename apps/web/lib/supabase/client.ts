import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@nightjar/db";
import { getSupabaseEnv } from "@/lib/env";

export type BrowserClient = ReturnType<typeof createBrowserClient<Database>>;

let client: BrowserClient | undefined;

/** Singleton browser Supabase client (cookie-backed session via @supabase/ssr). */
export function getBrowserClient(): BrowserClient {
  if (!client) {
    const { url, anonKey } = getSupabaseEnv();
    client = createBrowserClient<Database>(url, anonKey);
  }
  return client;
}
