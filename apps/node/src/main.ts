import { startApiServer } from "./api/server.js";
import { GdriveBackup } from "./backup/gdrive.js";
import { CameraManager } from "./cameras/manager.js";
import { CloudLink } from "./cloud/link.js";
import { IdentityStore } from "./config/identity.js";
import { ConfigStore } from "./config/store.js";
import { NodeDb } from "./db.js";
import { DetectWorker } from "./detect/worker.js";
import { EventPipeline } from "./events/pipeline.js";
import { Go2rtcSupervisor } from "./go2rtc/supervisor.js";
import { createLogger } from "./log.js";
import { MotionDetector } from "./motion/detector.js";
import { NestBridge } from "./nest/sdm.js";
import { StreamBreaker, StreamStartGate } from "./backoff.js";
import { Recorder } from "./recorder/recorder.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const log = createLogger("node");
  log.info(`Nightjar node v${VERSION} starting`);

  // Global guards: a stray rejection in a background worker must not take the
  // whole NVR down; a truly unknown synchronous throw still exits (default
  // Node contract) but only after the stack has hit the log.
  process.on("unhandledRejection", (reason) => {
    const message =
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    log.error(`unhandled promise rejection (continuing): ${message}`);
  });
  process.on("uncaughtException", (err) => {
    log.error(`uncaught exception: ${err.stack ?? err.message}`);
    // Brief delay so stderr flushes even when piped, then keep the fatal exit.
    setTimeout(() => process.exit(1), 100);
  });

  const store = new ConfigStore(log.child("config"));
  const identity = new IdentityStore(log.child("identity"));
  const db = new NodeDb();

  // Nest camera bridge (Google SDM) — supplies the params go2rtc's `nest:`
  // source lines need; re-renders go2rtc.yaml on connect/disconnect.
  const nest = new NestBridge({ store, log: log.child("nest") });
  nest.startProbe();

  const go2rtc = new Go2rtcSupervisor(store, log.child("go2rtc"), undefined, () =>
    nest.getStreamParams(),
  );
  await go2rtc.start();
  nest.onChange(() => void go2rtc.resync());

  const cameras = new CameraManager(store, log.child("cameras"));

  // Recorder and motion detector reconcile themselves on config changes.
  // One breaker for both capture loops: the rate limit they trip is per
  // Google project, not per camera or per consumer.
  const streamBreaker = new StreamBreaker();
  const streamGate = new StreamStartGate();
  const recorder = new Recorder(db, store, log.child("recorder"), streamBreaker, streamGate);
  // Disk-full writes free the oldest recordings instead of failing repeatedly.
  db.setDiskFullHandler(() => recorder.emergencyPrune());
  recorder.sync();
  const motion = new MotionDetector(store, log.child("motion"), streamBreaker, streamGate);
  motion.sync();
  const detect = new DetectWorker(log.child("detect"));

  // Optional user-owned Google Drive backup (device flow, drive.file scope).
  // Constructed before the cloud link: the link relays the device flow to the
  // dashboard at app.nightjar.ca, so it needs this instance.
  const gdrive = new GdriveBackup({ db, store, log: log.child("gdrive") });
  gdrive.start();

  const link = new CloudLink({
    store,
    identity,
    cameras,
    go2rtc,
    db,
    recorder,
    gdrive,
    version: VERSION,
    log: log.child("cloud"),
  });
  link.start();

  const pipeline = new EventPipeline({
    db,
    link,
    recorder,
    detect,
    store,
    gdrive,
    log: log.child("events"),
  });
  pipeline.attach(motion);
  // Drive backups publish their share URL through the pipeline (which owns the
  // cloud event_clips writes) — wired here because the pipeline needs gdrive.
  gdrive.setDriveUrlPublisher((eventId, driveUrl) => pipeline.publishDriveUrl(eventId, driveUrl));

  const api = await startApiServer({
    store,
    identity,
    cameras,
    go2rtc,
    link,
    db,
    recorder,
    gdrive,
    nest,
    version: VERSION,
    log: log.child("api"),
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received — shutting down`);
    void (async () => {
      try {
        pipeline.stop();
        nest.stopProbe();
        go2rtc.stop();
        // Wait for every capture/decoder child to actually exit (3s cap each)
        // so ffmpeg processes are not orphaned mid-segment.
        await Promise.allSettled([motion.stopAll(), recorder.stopAll()]);
        await Promise.allSettled([api.close(), link.stop(), detect.close(), gdrive.stop()]);
        db.close();
        log.info("shutdown complete");
        process.exit(0);
      } catch (err) {
        log.error(`shutdown error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
