import {
  GO2RTC_RTSP_PORT,
  go2rtcStreamName,
  type CameraConfig,
  type NodeConfig,
} from "@nightjar/shared";

/**
 * Where ffmpeg (recorder / motion detector) should pull a camera's video.
 *
 * RTSP cameras are pulled straight from the camera — unchanged. Nest cameras
 * have no direct RTSP URL: go2rtc ingests them via its native `nest:` source
 * and restreams over RTSP on GO2RTC_RTSP_PORT, so we pull them back out of
 * go2rtc there. The host comes from go2rtc.apiUrl (both containers share the
 * host network in the default compose file).
 */
export function go2rtcRestreamUrl(config: NodeConfig, streamName: string): string {
  const host = new URL(config.go2rtc.apiUrl).hostname;
  return `rtsp://${host}:${GO2RTC_RTSP_PORT}/${streamName}`;
}

/** Main-stream capture URL for recording and clip export. */
export function captureMainUrl(config: NodeConfig, camera: CameraConfig): string {
  if (camera.source === "nest") {
    return go2rtcRestreamUrl(config, go2rtcStreamName(camera.id));
  }
  if (!camera.rtspUrl) throw new Error(`camera ${camera.id} has no rtspUrl`);
  return camera.rtspUrl;
}

/** Substream capture URL for motion detection (falls back to the main stream;
 *  Nest cameras have no substream). */
export function captureSubUrl(config: NodeConfig, camera: CameraConfig): string {
  if (camera.source !== "nest" && camera.rtspSubUrl) return camera.rtspSubUrl;
  return captureMainUrl(config, camera);
}
