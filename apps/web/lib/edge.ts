import type { z } from "zod";
import { getSupabaseEnv } from "@/lib/env";
import { getBrowserClient } from "@/lib/supabase/client";

export class EdgeFunctionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EdgeFunctionError";
  }
}

type EdgeFunctionName = "node-claim" | "turn-credentials" | "share-clip" | "caption-clip";

function extractErrorMessage(payload: unknown, status: number): string {
  if (
    payload !== null &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof (payload as { error: unknown }).error === "string"
  ) {
    return (payload as { error: string }).error;
  }
  return `Request failed (${status})`;
}

/**
 * Calls a Supabase edge function with the signed-in user's access token and
 * validates the response against the given zod schema. Browser-only.
 */
export async function callEdgeFunction<TSchema extends z.ZodTypeAny>(
  name: EdgeFunctionName,
  body: unknown,
  schema: TSchema,
): Promise<z.infer<TSchema>> {
  const { url, anonKey } = getSupabaseEnv();
  const supabase = getBrowserClient();

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new EdgeFunctionError("You are signed out. Sign in and try again.", 401);

  const res = await fetch(`${url}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
    },
    body: JSON.stringify(body ?? {}),
  });

  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new EdgeFunctionError(extractErrorMessage(payload, res.status), res.status);

  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new EdgeFunctionError("Unexpected response from server.", 500);
  return parsed.data as z.infer<TSchema>;
}
