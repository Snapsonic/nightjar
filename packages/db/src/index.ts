import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types.js";

export type { Database, Json } from "./database.types.js";
export type NightjarClient = SupabaseClient<Database>;

export function createNightjarClient(
  url: string,
  key: string,
  accessToken?: string,
): NightjarClient {
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(accessToken
      ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } }
      : {}),
  });
}
