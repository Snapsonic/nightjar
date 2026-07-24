import { startApiServer } from "./api/server.js";
import { CameraManager } from "./cameras/manager.js";
import { CloudLink } from "./cloud/link.js";
import { IdentityStore } from "./config/identity.js";
import { ConfigStore } from "./config/store.js";
import { NodeDb } from "./db.js";
import { EventPipeline } from "./events/pipeline.js";
import { Go2rtcSupervisor } from "./go2rtc/supervisor.js";
import { createLogger } from "./log.js";
import { MotionDetector } from "./motion/detector.js";
import { Recorder } from "./recorder/recorder.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const log = createLogger("node");
  log.info(`Nightjar node v${VERSION} starting`);

  const store = new ConfigStore(log.child("config"));
  const identity = new IdentityStore(log.child("identity"));
  const db = new NodeDb();

  const go2rtc = new Go2rtcSupervisor(store, log.child("go2rtc"));
  await go2rtc.start();

  const cameras = new CameraManager(store, log.child("cameras"));

  const recorder = new Recorder(db, store, log.child("recorder"));
  const motion = new MotionDetector(log.child("motion"));
  for (const camera of store.get().cameras) {
    if (!camera.enabled) continue;
    if (camera.record) recorder.start(camera);
    if (camera.detect) motion.start(camera);
  }

  const link = new CloudLink({
    store,
    identity,
    cameras,
    go2rtc,
    version: VERSION,
    log: log.child("cloud"),
  });
  link.start();

  const pipeline = new EventPipeline({ db, link, log: log.child("events") });
  pipeline.attach(motion);

  const api = await startApiServer({
    store,
    identity,
    cameras,
    go2rtc,
    link,
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
        await Promise.allSettled([api.close(), link.stop()]);
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
