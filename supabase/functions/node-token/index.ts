// Node exchanges {nodeId, nodeSecret} for a Supabase session token.
// The machine user's JWT carries app_metadata.node_id, which RLS trusts.
// Returns claimed=false (no token) while the node is still unclaimed.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { adminClient, handleOptions, json, nodeEmail, sha256Hex } from "../_shared/util.ts";

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  const { nodeId, nodeSecret } = await req.json().catch(() => ({}));
  if (typeof nodeId !== "string" || typeof nodeSecret !== "string") {
    return json({ error: "nodeId and nodeSecret required" }, 400);
  }

  const admin = adminClient();
  const { data: node } = await admin
    .from("nodes")
    .select("id, site_id, node_secret_hash")
    .eq("id", nodeId)
    .maybeSingle();
  if (!node || node.node_secret_hash !== (await sha256Hex(nodeSecret))) {
    return json({ error: "invalid credentials" }, 401);
  }
  if (!node.site_id) return json({ claimed: false }, 200);

  const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false },
  });
  const { data: session, error } = await anon.auth.signInWithPassword({
    email: nodeEmail(nodeId),
    password: nodeSecret,
  });
  if (error || !session.session) return json({ error: error?.message ?? "sign-in failed" }, 500);

  return json({
    claimed: true,
    accessToken: session.session.access_token,
    expiresAt: new Date((session.session.expires_at ?? 0) * 1000).toISOString(),
  });
});
