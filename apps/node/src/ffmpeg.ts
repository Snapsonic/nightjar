/** Shared ffmpeg invocation details for the RTSP capture loops. */

/**
 * ffmpeg input socket timeout, in microseconds: abort a wedged RTSP read after
 * 30s so the restart path can recover instead of the process hanging forever.
 */
const INPUT_TIMEOUT_US = "30000000";

/**
 * The input half of every RTSP capture command (recorder and motion detector).
 *
 * This lives in one place because getting it wrong is silent and expensive.
 * The timeout MUST be spelled `-timeout`, not `-rw_timeout`: the RTSP demuxer
 * does not accept `-rw_timeout`, so ffmpeg exits immediately with
 * "Option not found" before it ever dials the stream. Every capture then looks
 * like an upstream outage, every loop retries, and the retries saturate the
 * Nest per-minute stream quota — which is exactly how five cameras went two
 * hours with zero recording while the logs blamed Google.
 */
export function rtspInputArgs(url: string): string[] {
  // prettier-ignore
  return [
    "-nostdin",
    "-loglevel", "error",
    "-rtsp_transport", "tcp",
    "-timeout", INPUT_TIMEOUT_US,
    "-i", url,
  ];
}
