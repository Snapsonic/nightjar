import Link from "next/link";
import { CameraCapabilities } from "@nightjar/shared";
import { NodeCameras, type CameraItem } from "@/components/node-cameras";
import { NodeStatusBadge } from "@/components/status-badge";
import { PairIcon } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { isNodeOnline, relativeTime, toNodeStatus } from "@/lib/utils";

function capabilityLabel(capabilities: unknown): string | null {
  const parsed = CameraCapabilities.safeParse(capabilities);
  if (!parsed.success) return null;
  const { height, fps } = parsed.data;
  if (!height) return null;
  return `${height}p${fps ? ` · ${Math.round(fps)} fps` : ""}`;
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
      Could not load your dashboard: {message}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-16 flex flex-col items-center rounded-2xl border border-dashed border-night-500 bg-night-850/60 px-6 py-16 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-night-700">
        <PairIcon className="h-7 w-7 text-ember-400" />
      </span>
      <h2 className="mt-5 text-lg font-semibold text-fog-100">No nodes yet</h2>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-fog-400">
        A Nightjar node is the small recorder that runs on your own hardware. Set one up, then pair
        it here with its 6-character claim code.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/pair"
          className="rounded-lg bg-ember-500 px-4 py-2 text-sm font-semibold text-night-950 transition-colors hover:bg-ember-400"
        >
          Set up a node
        </Link>
        <a
          href="https://github.com/Snapsonic/nightjar"
          target="_blank"
          rel="noreferrer"
          className="rounded-lg border border-night-500 px-4 py-2 text-sm font-medium text-fog-200 transition-colors hover:border-ember-500/50"
        >
          GitHub quickstart
        </a>
      </div>
    </div>
  );
}

export default async function DashboardPage() {
  const supabase = await createClient();

  const [sitesRes, nodesRes, camerasRes] = await Promise.all([
    supabase.from("sites").select("id, name").order("created_at", { ascending: true }),
    supabase
      .from("nodes")
      .select("id, site_id, name, status, last_seen_at, version")
      .order("created_at", { ascending: true }),
    supabase
      .from("cameras")
      .select("id, node_id, name, capabilities, enabled")
      .order("name", { ascending: true }),
  ]);

  const firstError = sitesRes.error ?? nodesRes.error ?? camerasRes.error;
  if (firstError) return <ErrorPanel message={firstError.message} />;

  const sites = sitesRes.data ?? [];
  const nodes = nodesRes.data ?? [];
  const cameras = camerasRes.data ?? [];
  const now = Date.now();

  if (nodes.length === 0) {
    return (
      <>
        <h1 className="text-xl font-semibold tracking-tight text-fog-100">Cameras</h1>
        <EmptyState />
      </>
    );
  }

  const camerasByNode = new Map<string, CameraItem[]>();
  for (const camera of cameras) {
    const list = camerasByNode.get(camera.node_id) ?? [];
    list.push({
      id: camera.id,
      name: camera.name,
      enabled: camera.enabled,
      capLabel: capabilityLabel(camera.capabilities),
    });
    camerasByNode.set(camera.node_id, list);
  }

  const nodesBySite = new Map<string | null, typeof nodes>();
  for (const node of nodes) {
    const list = nodesBySite.get(node.site_id) ?? [];
    list.push(node);
    nodesBySite.set(node.site_id, list);
  }

  return (
    <>
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-tight text-fog-100">Cameras</h1>
        <Link
          href="/pair"
          className="text-sm font-medium text-ember-400 underline-offset-4 hover:underline"
        >
          + Pair a node
        </Link>
      </div>

      <div className="mt-6 space-y-10">
        {sites.map((site) => {
          const siteNodes = nodesBySite.get(site.id) ?? [];
          if (siteNodes.length === 0) return null;
          return (
            <section key={site.id}>
              <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-fog-500">
                {site.name}
              </h2>
              <div className="mt-3 space-y-8">
                {siteNodes.map((node) => {
                  const online = isNodeOnline(toNodeStatus(node.status), node.last_seen_at, now);
                  const nodeCameras = camerasByNode.get(node.id) ?? [];
                  return (
                    <div key={node.id}>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <h3 className="text-base font-semibold text-fog-100">{node.name}</h3>
                        <NodeStatusBadge online={online} />
                        <span className="text-xs text-fog-500">
                          {node.last_seen_at
                            ? `last seen ${relativeTime(node.last_seen_at, now)}`
                            : "never seen"}
                          {node.version ? ` · v${node.version}` : ""}
                          {` · ${nodeCameras.length} camera${nodeCameras.length === 1 ? "" : "s"}`}
                        </span>
                      </div>
                      <div className="mt-3">
                        <NodeCameras nodeId={node.id} online={online} cameras={nodeCameras} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
