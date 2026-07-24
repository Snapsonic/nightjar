// Called by a signed-in user with the claim code shown on the node's local UI.
// Attaches the node to the user's site (creating a default site if needed).
import { adminClient, callerClient, handleOptions, json } from "../_shared/util.ts";

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  const caller = callerClient(req);
  const { data: auth } = await caller.auth.getUser();
  if (!auth?.user) return json({ error: "unauthorized" }, 401);

  const { claimCode, siteName } = await req.json().catch(() => ({}));
  if (typeof claimCode !== "string" || claimCode.length !== 6) {
    return json({ error: "invalid claim code" }, 400);
  }

  const admin = adminClient();

  let { data: site } = await admin
    .from("sites")
    .select("id")
    .eq("owner_id", auth.user.id)
    .limit(1)
    .maybeSingle();
  if (!site) {
    const { data: created, error } = await admin
      .from("sites")
      .insert({ owner_id: auth.user.id, name: siteName ?? "Home" })
      .select("id")
      .single();
    if (error) return json({ error: error.message }, 500);
    site = created;
  }

  // Atomic claim: only matches an unclaimed, unexpired code.
  const { data: node, error } = await admin
    .from("nodes")
    .update({ site_id: site.id, claim_code: null, claim_code_expires_at: null, status: "offline" })
    .eq("claim_code", claimCode.toUpperCase())
    .is("site_id", null)
    .gt("claim_code_expires_at", new Date().toISOString())
    .select("id")
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!node) return json({ error: "code not found or expired" }, 404);

  return json({ nodeId: node.id, siteId: site.id });
});
