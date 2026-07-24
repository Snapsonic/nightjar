// Called anonymously by a fresh node on first boot.
// Creates an unclaimed `nodes` row + a machine auth user, returns a short-lived
// claim code the node shows in its local UI.
import { adminClient, generateClaimCode, handleOptions, json, nodeEmail, sha256Hex } from "../_shared/util.ts";

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  const { nodeSecret, nodeName, version } = await req.json().catch(() => ({}));
  if (typeof nodeSecret !== "string" || nodeSecret.length < 32) {
    return json({ error: "nodeSecret must be at least 32 chars" }, 400);
  }

  const admin = adminClient();
  const claimCode = generateClaimCode();
  const claimCodeExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const { data: node, error } = await admin
    .from("nodes")
    .insert({
      name: typeof nodeName === "string" && nodeName ? nodeName.slice(0, 80) : "nightjar-node",
      claim_code: claimCode,
      claim_code_expires_at: claimCodeExpiresAt,
      node_secret_hash: await sha256Hex(nodeSecret),
      version: typeof version === "string" ? version.slice(0, 40) : null,
    })
    .select("id")
    .single();
  if (error) return json({ error: error.message }, 500);

  const { error: userError } = await admin.auth.admin.createUser({
    email: nodeEmail(node.id),
    password: nodeSecret,
    email_confirm: true,
    app_metadata: { node_id: node.id },
  });
  if (userError) {
    await admin.from("nodes").delete().eq("id", node.id);
    return json({ error: userError.message }, 500);
  }

  return json({ nodeId: node.id, claimCode, claimCodeExpiresAt });
});
