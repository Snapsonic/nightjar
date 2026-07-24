import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@nightjar/db";
import { getSupabaseEnv } from "@/lib/env";

export type ServerClient = ReturnType<typeof createServerClient<Database>>;

/**
 * Per-request server Supabase client. Reads the session from request cookies;
 * cookie writes are attempted but may no-op inside Server Components (the
 * middleware keeps the session refreshed).
 */
export async function createClient(): Promise<ServerClient> {
  const cookieStore = await cookies();
  const { url, anonKey } = getSupabaseEnv();

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component — safe to ignore, middleware
          // handles session refresh.
        }
      },
    },
  });
}
