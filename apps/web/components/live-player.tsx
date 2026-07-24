"use client";

import { useEffect, useRef, useState } from "react";
import { TurnCredentialsResponse } from "@nightjar/shared";
import { EdgeFunctionError, callEdgeFunction } from "@/lib/edge";
import { NodeChannel, NodeChannelError } from "@/lib/realtime";
import { getBrowserClient } from "@/lib/supabase/client";

type ConnState = "connecting" | "connected" | "failed";

const ICE_GATHER_TIMEOUT_MS = 3_000;
const WHEP_ANSWER_TIMEOUT_MS = 15_000;

/** Resolves when ICE gathering completes, or after `timeoutMs` (trickle fallback). */
function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof NodeChannelError || err instanceof EdgeFunctionError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong while connecting.";
}

/**
 * WHEP-over-Realtime live player: fetches TURN credentials, builds a
 * recv-only RTCPeerConnection, exchanges SDP with the node over the private
 * `node:{nodeId}` channel and plays the resulting stream.
 */
export function LivePlayer({
  cameraId,
  nodeId,
  nodeOnline,
}: {
  cameraId: string;
  nodeId: string;
  nodeOnline: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<ConnState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let channel: NodeChannel | null = null;

    const fail = (message: string) => {
      if (!cancelled) {
        setError(message);
        setState("failed");
      }
    };

    const start = async () => {
      setState("connecting");
      setError(null);
      try {
        // 1. ICE servers (STUN always, short-lived TURN when configured).
        const turn = await callEdgeFunction("turn-credentials", {}, TurnCredentialsResponse);
        if (cancelled) return;

        // 2. Receive-only peer connection.
        pc = new RTCPeerConnection({ iceServers: turn.iceServers });
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });

        pc.ontrack = (event) => {
          const stream = event.streams[0];
          const video = videoRef.current;
          if (stream && video && video.srcObject !== stream) {
            video.srcObject = stream;
          }
        };

        pc.onconnectionstatechange = () => {
          if (cancelled || !pc) return;
          switch (pc.connectionState) {
            case "connected":
              setState("connected");
              setError(null);
              break;
            case "failed":
              fail("The media connection failed. Your network may be blocking WebRTC.");
              break;
            case "disconnected":
              fail("The media connection was lost.");
              break;
            default:
              break;
          }
        };

        // 3. Offer with gathered candidates (3s cap, then trickle-less send).
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc, ICE_GATHER_TIMEOUT_MS);
        if (cancelled) return;
        const sdp = pc.localDescription?.sdp;
        if (!sdp) throw new Error("Could not build a WebRTC offer.");

        // 4. Signal through the node's private channel.
        channel = await NodeChannel.connect(getBrowserClient(), nodeId);
        if (cancelled) return;
        const answerSdp = await channel.requestWhepAnswer(
          cameraId,
          sdp,
          true,
          WHEP_ANSWER_TIMEOUT_MS,
        );
        if (cancelled) return;

        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      } catch (err) {
        fail(errorMessage(err));
      }
    };

    void start();

    return () => {
      cancelled = true;
      channel?.close();
      pc?.close();
      const video = videoRef.current;
      if (video) video.srcObject = null;
    };
  }, [cameraId, nodeId, attempt]);

  return (
    <div className="overflow-hidden rounded-2xl border border-night-600 bg-night-950">
      <div className="relative aspect-video w-full">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          controls
          className="absolute inset-0 h-full w-full bg-night-950 object-contain"
        />

        {state !== "connected" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-night-950/85 px-6 text-center">
            {state === "connecting" ? (
              <>
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-night-500 border-t-ember-400" />
                <p className="text-sm text-fog-300">Connecting to the camera…</p>
                {!nodeOnline && (
                  <p className="max-w-sm text-xs text-fog-500">
                    This node looks offline — the stream will fail unless it has just come back.
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-danger">Could not start the live stream</p>
                {error && <p className="max-w-md text-xs leading-relaxed text-fog-400">{error}</p>}
                <button
                  type="button"
                  onClick={() => setAttempt((n) => n + 1)}
                  className="mt-1 rounded-lg bg-ember-500 px-4 py-2 text-sm font-semibold text-night-950 transition-colors hover:bg-ember-400"
                >
                  Retry
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-night-700 px-4 py-2.5">
        <span className="flex items-center gap-2 text-xs text-fog-400">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              state === "connected"
                ? "bg-online"
                : state === "connecting"
                  ? "animate-pulse bg-ember-400"
                  : "bg-danger"
            }`}
            aria-hidden="true"
          />
          {state === "connected"
            ? "Live · substream"
            : state === "connecting"
              ? "Connecting…"
              : "Disconnected"}
        </span>
        <span className="text-[11px] text-fog-500">WebRTC · peer-to-peer when possible</span>
      </div>
    </div>
  );
}
