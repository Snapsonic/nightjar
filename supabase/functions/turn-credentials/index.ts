// Returns ICE servers for WebRTC. STUN always; short-lived Cloudflare TURN
// credentials when CF_TURN_KEY_ID / CF_TURN_API_TOKEN secrets are configured.
import { callerClient, handleOptions, json } from "../_shared/util.ts";

const STUN = ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"];
const TTL_SEC = 3600;

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  const { data: auth } = await callerClient(req).auth.getUser();
  if (!auth?.user) return json({ error: "unauthorized" }, 401);

  const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> =
    STUN.map((urls) => ({ urls }));

  const keyId = Deno.env.get("CF_TURN_KEY_ID");
  const apiToken = Deno.env.get("CF_TURN_API_TOKEN");
  if (keyId && apiToken) {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: TTL_SEC }),
      },
    );
    if (res.ok) {
      const body = await res.json();
      for (const server of body.iceServers ?? []) iceServers.push(server);
    }
  }

  return json({ iceServers, ttlSec: TTL_SEC });
});
