import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { CameraCapabilities, Zone } from "@nightjar/shared";
import { LivePlayer } from "@/components/live-player";
import { ZoneEditor } from "@/components/zone-editor";
import { NodeStatusBadge } from "@/components/status-badge";
import { TimelineHistory } from "@/components/timeline-history";
import { createClient } from "@/lib/supabase/server";
import { isNodeOnline, toNodeStatus } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Live view — Nightjar",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LivePage({
  params,
  searchParams,
}: {
  params: Promise<{ cameraId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { cameraId } = await params;
  if (!UUID_RE.test(cameraId)) notFound();

  // ?tab=history (dashboard "History" action): focus the history section and
  // do NOT auto-open the live WebRTC session — live is one click away.
  const { tab } = await searchParams;
  const historyTab = (Array.isArray(tab) ? tab[0] : tab) === "history";

  const supabase = await createClient();
  const { data: camera, error } = await supabase
    .from("cameras")
    .select("id, node_id, name, enabled, capabilities, zones")
    .eq("id", cameraId)
    .maybeSingle();

  if (error) {
    return (
      <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
        Could not load this camera: {error.message}
      </div>
    );
  }
  if (!camera) notFound();

  const { data: node, error: nodeError } = await supabase
    .from("nodes")
    .select("id, name, status, last_seen_at")
    .eq("id", camera.node_id)
    .maybeSingle();

  if (nodeError) {
    return (
      <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
        Could not load this camera&apos;s node: {nodeError.message}
      </div>
    );
  }

  const online = node ? isNodeOnline(toNodeStatus(node.status), node.last_seen_at) : false;

  // The node syncs CameraPublic.capabilities into the jsonb column; tolerate
  // rows written by older node builds (fields are additive with defaults).
  const parsedCapabilities = CameraCapabilities.safeParse(camera.capabilities ?? {});
  const capabilities = parsedCapabilities.success
    ? parsedCapabilities.data
    : CameraCapabilities.parse({});

  // Zones synced from the node (jsonb, additive). Rows written before the
  // zones migration/node build parse to [].
  const parsedZones = z.array(Zone).safeParse(camera.zones ?? []);
  const zones = parsedZones.success ? parsedZones.data : [];

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link
          href="/"
          className="text-sm font-medium text-fog-400 transition-colors hover:text-fog-200"
        >
          ← Cameras
        </Link>
        <span className="text-night-500">/</span>
        <h1 className="text-lg font-semibold tracking-tight text-fog-100">{camera.name}</h1>
        <NodeStatusBadge online={online} />
        {node && <span className="text-xs text-fog-500">on {node.name}</span>}
      </div>

      <div id="live" className="mt-5 scroll-mt-4">
        {!camera.enabled ? (
          <div className="flex aspect-video w-full items-center justify-center rounded-2xl border border-night-600 bg-night-850 text-sm text-fog-400">
            This camera is disabled on its node.
          </div>
        ) : (
          <LivePlayer
            cameraId={camera.id}
            nodeId={camera.node_id}
            nodeOnline={online}
            capabilities={capabilities}
            autoConnect={!historyTab}
          />
        )}
      </div>

      <ZoneEditor
        cameraId={camera.id}
        nodeId={camera.node_id}
        nodeOnline={online}
        initialZones={zones}
      />

      <TimelineHistory cameraId={camera.id} nodeId={camera.node_id} autoFocus={historyTab} />
    </>
  );
}
