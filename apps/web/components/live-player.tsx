"use client";

import { useEffect, useRef, useState } from "react";
import { TurnCredentialsResponse, type CameraCapabilities } from "@nightjar/shared";
import { EdgeFunctionError, callEdgeFunction } from "@/lib/edge";
import { NodeChannel, NodeChannelError } from "@/lib/realtime";
import { getBrowserClient } from "@/lib/supabase/client";

type ConnState = "connecting" | "connected" | "failed";

/** Talkback microphone availability for this attempt. */
type MicState = "none" | "ready" | "denied" | "insecure";

const ICE_GATHER_TIMEOUT_MS = 3_000;
const WHEP_ANSWER_TIMEOUT_MS = 15_000;
/** "disconnected" often self-heals (wifi blip, wake from sleep) — wait this
 *  long before declaring the stream lost. */
const DISCONNECT_GRACE_MS = 5_000;
/** Automatic reconnect backoff after a failure; after these, manual Retry only. */
const AUTO_RETRY_DELAYS_MS = [5_000, 10_000, 20_000] as const;

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
 * RTCPeerConnection (recv-only, plus a sendrecv mic track when the camera
 * supports talkback), exchanges SDP with the node over the private
 * `node:{nodeId}` channel and plays the resulting stream.
 *
 * Audio starts muted (browser autoplay policy) with an unmute toggle.
 * Push-to-talk: cameras with capabilities.talkback === "backchannel" get a
 * hold-to-talk button — the mic track is added before the offer but stays
 * disabled until the button is held.
 */
export function LivePlayer({
  cameraId,
  nodeId,
  nodeOnline,
  capabilities,
  autoConnect = true,
}: {
  cameraId: string;
  nodeId: string;
  nodeOnline: boolean;
  capabilities?: CameraCapabilities;
  /** When false (?tab=history deep link), no WebRTC session is opened until
   *  the user clicks "Start live" — saves a stream session on the camera. */
  autoConnect?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  /** Automatic retries consumed since the last successful connection. */
  const autoRetryRef = useRef(0);
  const stateRef = useRef<ConnState>("connecting");
  const [started, setStarted] = useState(autoConnect);
  const [state, setState] = useState<ConnState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [muted, setMuted] = useState(true);
  const [micState, setMicState] = useState<MicState>("none");
  const [talking, setTalking] = useState(false);

  const wantsTalkback = capabilities?.talkback === "backchannel";
  // Older node builds didn't write hasAudio — fall back to audioCodec presence.
  const hasAudio = capabilities
    ? (capabilities.hasAudio ?? capabilities.audioCodec !== undefined)
    : false;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let channel: NodeChannel | null = null;
    let micStream: MediaStream | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const clearGrace = () => {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    };

    const fail = (message: string) => {
      if (!cancelled) {
        setError(message);
        setState("failed");
      }
    };

    const start = async () => {
      setState("connecting");
      setError(null);
      setMicState("none");
      setTalking(false);
      try {
        // 1. ICE servers (STUN always, short-lived TURN when configured).
        const turn = await callEdgeFunction("turn-credentials", {}, TurnCredentialsResponse);
        if (cancelled) return;

        // 2. Microphone (talkback cameras only) — must exist BEFORE the
        // offer; go2rtc's answer is one-shot, no renegotiation.
        if (wantsTalkback) {
          if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
            // getUserMedia requires a secure context (HTTPS or localhost).
            setMicState("insecure");
          } else {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              if (cancelled) {
                // Unmounted while the permission prompt was open — release the
                // mic immediately, or the recording indicator stays on.
                stream.getTracks().forEach((track) => track.stop());
                return;
              }
              micStream = stream;
            } catch {
              if (!cancelled) setMicState("denied");
            }
          }
        }
        if (cancelled) return;

        // 3. Peer connection: recv-only video; audio is sendrecv when we
        // hold a mic track, recv-only otherwise.
        pc = new RTCPeerConnection({ iceServers: turn.iceServers });
        pc.addTransceiver("video", { direction: "recvonly" });
        const micTrack = micStream?.getAudioTracks()[0] ?? null;
        if (micTrack) {
          micTrack.enabled = false; // push-to-talk: off until held
          pc.addTransceiver(micTrack, { direction: "sendrecv" });
          micTrackRef.current = micTrack;
          setMicState("ready");
        } else {
          pc.addTransceiver("audio", { direction: "recvonly" });
        }

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
              clearGrace();
              autoRetryRef.current = 0; // fresh backoff budget after recovery
              setState("connected");
              setError(null);
              break;
            case "failed":
              clearGrace();
              fail("The media connection failed. Your network may be blocking WebRTC.");
              break;
            case "disconnected":
              // Grace period: only treat it as a failure if it doesn't recover.
              graceTimer ??= setTimeout(() => {
                graceTimer = null;
                const current = pc?.connectionState;
                if (
                  !cancelled &&
                  (current === "disconnected" || current === "failed" || current === "closed")
                ) {
                  fail("The media connection was lost.");
                }
              }, DISCONNECT_GRACE_MS);
              break;
            default:
              break;
          }
        };

        // 4. Offer with gathered candidates (3s cap, then trickle-less send).
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc, ICE_GATHER_TIMEOUT_MS);
        if (cancelled) return;
        const sdp = pc.localDescription?.sdp;
        if (!sdp) throw new Error("Could not build a WebRTC offer.");

        // 5. Signal through the node's private channel.
        const connected = await NodeChannel.connect(getBrowserClient(), nodeId);
        if (cancelled) {
          // Unmounted mid-connect — release the shared channel reference now,
          // the cleanup below already ran and can't see this handle.
          connected.close();
          return;
        }
        channel = connected;
        const answerSdp = await channel.requestWhepAnswer(
          cameraId,
          sdp,
          true,
          WHEP_ANSWER_TIMEOUT_MS,
        );
        if (cancelled) return;

        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      } catch (err) {
        // Failed attempts must not hold the mic open until unmount.
        micStream?.getTracks().forEach((track) => track.stop());
        micStream = null;
        micTrackRef.current = null;
        fail(errorMessage(err));
      }
    };

    void start();

    return () => {
      cancelled = true;
      clearGrace();
      channel?.close();
      pc?.close();
      micTrackRef.current = null;
      micStream?.getTracks().forEach((track) => track.stop());
      const video = videoRef.current;
      if (video) video.srcObject = null;
    };
  }, [cameraId, nodeId, attempt, wantsTalkback, started]);

  // Auto-reconnect with capped backoff (5s → 10s → 20s, then manual Retry
  // only). `attempt` is a dep so each failed automatic attempt reschedules.
  useEffect(() => {
    if (!started || state !== "failed") return;
    const used = autoRetryRef.current;
    if (used >= AUTO_RETRY_DELAYS_MS.length) return;
    const timer = setTimeout(() => {
      autoRetryRef.current = used + 1;
      setAttempt((n) => n + 1);
    }, AUTO_RETRY_DELAYS_MS[used] ?? 20_000);
    return () => clearTimeout(timer);
  }, [started, state, attempt]);

  // Coming back from a hidden tab / sleep / offline network: if the stream is
  // broken, reconnect right away with a fresh automatic-retry budget.
  useEffect(() => {
    if (!started) return;
    const retryIfBroken = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (stateRef.current !== "failed") return;
      autoRetryRef.current = 0;
      setAttempt((n) => n + 1);
    };
    document.addEventListener("visibilitychange", retryIfBroken);
    window.addEventListener("online", retryIfBroken);
    return () => {
      document.removeEventListener("visibilitychange", retryIfBroken);
      window.removeEventListener("online", retryIfBroken);
    };
  }, [started]);

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  };

  const startTalking = () => {
    const track = micTrackRef.current;
    if (!track || state !== "connected") return;
    track.enabled = true;
    setTalking(true);
  };

  const stopTalking = () => {
    const track = micTrackRef.current;
    if (track) track.enabled = false;
    setTalking(false);
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-night-600 bg-night-950">
      <div className="relative aspect-video w-full">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          controls
          onVolumeChange={() => {
            const video = videoRef.current;
            if (video) setMuted(video.muted);
          }}
          className="absolute inset-0 h-full w-full bg-night-950 object-contain"
        />

        {!started && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-night-950/85 px-6 text-center">
            <p className="text-sm text-fog-300">Live view is paused.</p>
            <button
              type="button"
              onClick={() => setStarted(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-ember-500 px-4 py-2 text-sm font-semibold text-night-950 transition-colors hover:bg-ember-400"
            >
              Start live
            </button>
            <p className="max-w-sm text-xs text-fog-500">
              Starting live opens a stream session on the camera.
            </p>
          </div>
        )}

        {started && state !== "connected" && (
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
                  onClick={() => {
                    autoRetryRef.current = 0;
                    setAttempt((n) => n + 1);
                  }}
                  className="mt-1 rounded-lg bg-ember-500 px-4 py-2 text-sm font-semibold text-night-950 transition-colors hover:bg-ember-400"
                >
                  Retry
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-night-700 px-4 py-2.5">
        <span className="flex items-center gap-2 text-xs text-fog-400">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              !started
                ? "bg-night-500"
                : state === "connected"
                  ? "bg-online"
                  : state === "connecting"
                    ? "animate-pulse bg-ember-400"
                    : "bg-danger"
            }`}
            aria-hidden="true"
          />
          {!started
            ? "Live paused"
            : state === "connected"
              ? "Live · substream"
              : state === "connecting"
                ? "Connecting…"
                : "Disconnected"}
        </span>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleMute}
            disabled={state !== "connected"}
            className="rounded-lg border border-night-600 px-3 py-1.5 text-xs font-medium text-fog-300 transition-colors hover:border-night-500 hover:text-fog-100 disabled:cursor-not-allowed disabled:opacity-50"
            aria-pressed={!muted}
          >
            {muted ? "Unmute" : "Mute"}
          </button>

          {wantsTalkback ? (
            micState === "ready" ? (
              <button
                type="button"
                onPointerDown={startTalking}
                onPointerUp={stopTalking}
                onPointerLeave={stopTalking}
                onPointerCancel={stopTalking}
                onContextMenu={(event) => event.preventDefault()}
                disabled={state !== "connected"}
                className={`select-none touch-none rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  talking
                    ? "bg-ember-400 text-night-950"
                    : "bg-ember-500 text-night-950 hover:bg-ember-400"
                }`}
                aria-pressed={talking}
              >
                {talking ? "Talking…" : "Hold to talk"}
              </button>
            ) : (
              <span className="text-[11px] text-fog-500">
                {micState === "insecure"
                  ? "Talkback needs HTTPS or localhost"
                  : micState === "denied"
                    ? "Microphone blocked — allow it to talk"
                    : "Preparing microphone…"}
              </span>
            )
          ) : hasAudio ? (
            <span
              className="text-[11px] text-fog-500"
              title="This camera has no audio backchannel, so Nightjar can't send your voice to it."
            >
              This camera can&apos;t receive audio
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
