import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NodeConfig } from "@nightjar/shared";
import { Emitter } from "../emitter.js";
import type { Logger } from "../log.js";

export function configDir(): string {
  return process.env.CONFIG_DIR ?? "/config";
}

/**
 * NodeConfig persisted at ${CONFIG_DIR}/config.json (default /config).
 * Writes are atomic (tmp file + rename). Loading a missing file yields the
 * zod defaults; a corrupt/invalid file throws so we never clobber user config.
 */
export class ConfigStore {
  private readonly file: string;
  private config: NodeConfig;
  private readonly emitter = new Emitter<NodeConfig>();

  constructor(
    private readonly log: Logger,
    dir: string = configDir(),
  ) {
    this.file = path.join(dir, "config.json");
    this.config = this.loadFromDisk();
  }

  private loadFromDisk(): NodeConfig {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const defaults = NodeConfig.parse({});
        this.log.info(`no config at ${this.file}; writing defaults`);
        this.writeAtomic(defaults);
        return defaults;
      }
      throw err;
    }
    const parsed = NodeConfig.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(`invalid config at ${this.file}: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  private writeAtomic(config: NodeConfig): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    renameSync(tmp, this.file);
  }

  get(): NodeConfig {
    return this.config;
  }

  /** Shallow-merge a patch, validate, persist atomically, notify listeners. */
  update(patch: Partial<NodeConfig>): NodeConfig {
    const next = NodeConfig.parse({ ...this.config, ...patch });
    this.writeAtomic(next);
    this.config = next;
    this.emitter.emit(next);
    return next;
  }

  /** Subscribe to config changes. Returns an unsubscribe function. */
  onChange(listener: (config: NodeConfig) => void): () => void {
    return this.emitter.on(listener);
  }
}
