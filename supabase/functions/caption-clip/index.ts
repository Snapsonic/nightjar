// AI caption generation for clip sharing (roadmap #17 extended).
//
// Authenticated with the signed-in user's JWT. POST {eventId} -> a short,
// social-ready caption for the event's thumbnail via the Claude API
// (structured output: {caption, safe_to_share, reason?}). safe_to_share is
// false when the image clearly shows an identifiable person's face — the UI
// warns before sharing. Every failure path (refusal, API error, malformed
// output, missing thumbnail) degrades to a generic "<Kind> detected at
// <camera>" caption with 200 — this function never breaks the share flow.
//
// Env: ANTHROPIC_API_KEY (orchestrator secret). ANTHROPIC_BASE_URL is
// honored for testing against a mock API.
import Anthropic from "npm:@anthropic-ai/sdk";
import { adminClient, callerClient, handleOptions, json } from "../_shared/util.ts";

const MODEL = "claude-opus-5";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Structured-output contract; `reason` explains a safe_to_share=false. */
const CAPTION_SCHEMA = {
  type: "object",
  properties: {
    caption: { type: "string" },
    safe_to_share: { type: "boolean" },
    reason: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["caption", "safe_to_share", "reason"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = [
  "You write captions for short home-security clips that users share to social media.",
  "Rules:",
  "- Exactly one sentence, at most 140 characters.",
  "- Describe only what is actually visible in the thumbnail plus the event metadata you are given. Never invent details.",
  "- No hashtags unless one arises completely naturally from the content.",
  "- If the image is unclear, dark, or you cannot tell what is happening, fall back to a plain factual line like \"Motion detected at <camera name>\".",
  "- If a person's face is clearly identifiable in the image, set safe_to_share to false and explain why in reason; still provide a caption that does not identify anyone.",
  "- Otherwise set safe_to_share to true and reason to null.",
].join("\n");

interface CaptionResult {
  caption: string;
  safe_to_share: boolean;
  reason: string | null;
  /** True when the model was unavailable and a generic caption was used. */
  fallback: boolean;
}

function fallbackCaption(kind: string, cameraName: string): CaptionResult {
  return {
    caption: `${capitalize(kind)} detected at ${cameraName}`,
    safe_to_share: true,
    reason: null,
    fallback: true,
  };
}

function parseCaption(text: string | undefined): Omit<CaptionResult, "fallback"> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.caption === "string" &&
      parsed.caption.length > 0 &&
      typeof parsed.safe_to_share === "boolean"
    ) {
      return {
        caption: parsed.caption,
        safe_to_share: parsed.safe_to_share,
        reason: typeof parsed.reason === "string" ? parsed.reason : null,
      };
    }
  } catch {
    // malformed JSON — fall through to the generic caption
  }
  return null;
}

async function generateCaption(
  thumbnailB64: string,
  kind: string,
  cameraName: string,
  startedAt: string,
): Promise<CaptionResult> {
  const client = new Anthropic({
    apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
    baseURL: Deno.env.get("ANTHROPIC_BASE_URL") || undefined,
    maxRetries: 1,
  });

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 1024,
      // Opus 5 thinks by default; low effort keeps thinking + the one-line
      // structured answer comfortably inside max_tokens for this simple task.
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: CAPTION_SCHEMA },
      },
      // Safety classifiers can decline a request; "default" re-runs it on
      // Anthropic's recommended fallback model server-side.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: thumbnailB64 },
            },
            {
              type: "text",
              text:
                `Event metadata: kind=${kind}, camera="${cameraName}", ` +
                `local time=${startedAt}. Write the caption.`,
            },
          ],
        },
      ],
    });

    // The whole chain declined — never surface a refusal to the share UI.
    if (response.stop_reason === "refusal") return fallbackCaption(kind, cameraName);

    const text = response.content.find((block) => block.type === "text")?.text;
    const parsed = parseCaption(text);
    if (!parsed) return fallbackCaption(kind, cameraName);
    return { ...parsed, fallback: false };
  } catch (err) {
    // Rate limits, 5xx, network — degrade, never 500 the UI.
    console.error("caption-clip: Claude API call failed:", err);
    return fallbackCaption(kind, cameraName);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000; // avoid call-stack limits on large thumbnails
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const { data: auth } = await callerClient(req).auth.getUser();
  const userId = auth?.user?.id;
  if (!userId || auth?.user?.app_metadata?.node_id) {
    return json({ error: "sign in required" }, 401);
  }

  const { eventId } = await req.json().catch(() => ({}));
  if (typeof eventId !== "string" || eventId === "") {
    return json({ error: "eventId required" }, 400);
  }

  const admin = adminClient();
  const { data: event } = await admin
    .from("events")
    .select("id, node_id, camera_id, kind, started_at, thumbnail_path")
    .eq("id", eventId)
    .maybeSingle();
  if (!event) return json({ error: "event not found" }, 404);

  // Ownership: events.node_id -> nodes.site_id -> sites.owner_id.
  const { data: node } = await admin
    .from("nodes")
    .select("site_id")
    .eq("id", event.node_id)
    .maybeSingle();
  const { data: site } = node?.site_id
    ? await admin.from("sites").select("owner_id").eq("id", node.site_id).maybeSingle()
    : { data: null };
  if (site?.owner_id !== userId) return json({ error: "not your event" }, 403);

  const { data: camera } = await admin
    .from("cameras")
    .select("name")
    .eq("id", event.camera_id)
    .maybeSingle();
  const cameraName = camera?.name ?? "Camera";

  if (!event.thumbnail_path) {
    return json(fallbackCaption(event.kind, cameraName));
  }

  const { data: thumbBlob, error: downloadError } = await admin.storage
    .from("event-clips")
    .download(event.thumbnail_path);
  if (downloadError || !thumbBlob) {
    return json(fallbackCaption(event.kind, cameraName));
  }
  const thumbnailB64 = bytesToBase64(new Uint8Array(await thumbBlob.arrayBuffer()));

  return json(
    await generateCaption(thumbnailB64, event.kind, cameraName, event.started_at),
  );
});
