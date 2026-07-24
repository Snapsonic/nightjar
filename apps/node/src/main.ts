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
import { Recorder } from "./recorder/recorder.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const log = createLogger("node");
  log.info(`Nightjar node v${VERSION} starting`);

  const store = new ConfigStore(log.child("config"));
  const identity = new IdentityStore(log.child("identity"));
  const db = new NodeDb();

  // Nest camera bridge (Google SDM) — supplies the params go2rtc's `nest:`
  // source lines need; re-renders go2rtc.yaml on connect/disconnect.
  const nest = new NestBridge({ store, log: log.child("nest") });

  const go2rtc = new Go2rtcSupervisor(store, log.child("go2rtc"), undefined, () =>
    nest.getStreamParams(),
  );
  await go2rtc.start();
  nest.onChange(() => void go2rtc.resync());

  const cameras = new CameraManager(store, log.child("cameras"));

  // Recorder and motion detector reconcile themselves on config changes.
  const recorder = new Recorder(db, store, log.child("recorder"));
  recorder.sync();
  const motion = new MotionDetector(store, log.child("motion"));
  motion.sync();
  const detect = new DetectWorker(log.child("detect"));

  const link = new CloudLink({
    store,
    identity,
    cameras,
    go2rtc,
    version: VERSION,
    log: log.child("cloud"),
  });
  link.start();

  // Optional user-owned Google Drive backup (device flow, drive.file scope).
  const gdrive = new GdriveBackup({ db, store, log: log.child("gdrive") });
  gdrive.start();

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

  const api = await startApiServer({
    store,
    identity,
    cameras,
    go2rtc,
    link,
    db,
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
        motion.stopAll();
        recorder.stopAll();
        go2rtc.stop();
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
