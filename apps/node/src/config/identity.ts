import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configDir } from "./store.js";
import type { Logger } from "../log.js";

const IdentitySchema = z.object({
  nodeId: z.string().uuid().optional(),
  nodeSecret: z.string().min(32),
  /** Pairing code from node-register, kept until the node is claimed. */
  claimCode: z.string().optional(),
  claimCodeExpiresAt: z.string().optional(),
});
export type NodeIdentity = z.infer<typeof IdentitySchema>;

/**
 * Node identity persisted at ${CONFIG_DIR}/identity.json.
 * nodeSecret is generated on first boot (48 random bytes, base64url) and is
 * the node's permanent machine credential. nodeId is filled in after the
 * node-register edge function assigns one; the claim code is persisted
 * alongside it so the UI can still show it after a restart, and cleared once
 * the node is claimed.
 */
export class IdentityStore {
  private readonly file: string;
  private identity: NodeIdentity;

  constructor(
    private readonly log: Logger,
    dir: string = configDir(),
  ) {
    this.file = path.join(dir, "identity.json");
    this.identity = this.loadOrCreate();
  }

  private loadOrCreate(): NodeIdentity {
    try {
      const raw = readFileSync(this.file, "utf8");
      return IdentitySchema.parse(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const identity: NodeIdentity = {
        nodeSecret: randomBytes(48).toString("base64url"),
      };
      this.log.info("generated new node identity");
      this.writeAtomic(identity);
      return identity;
    }
  }

  private writeAtomic(identity: NodeIdentity): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get(): NodeIdentity {
    return this.identity;
  }

  setNodeId(nodeId: string): void {
    this.identity = IdentitySchema.parse({ ...this.identity, nodeId });
    this.writeAtomic(this.identity);
  }

  /** Persist the registration result (nodeId + claim code) in one write. */
  setRegistration(nodeId: string, claimCode: string, claimCodeExpiresAt: string): void {
    this.identity = IdentitySchema.parse({
      ...this.identity,
      nodeId,
      claimCode,
      claimCodeExpiresAt,
    });
    this.writeAtomic(this.identity);
  }

  /** Drop the stored claim code once the node has been claimed. */
  clearClaim(): void {
    if (this.identity.claimCode === undefined && this.identity.claimCodeExpiresAt === undefined) {
      return;
    }
    const { claimCode: _code, claimCodeExpiresAt: _expires, ...rest } = this.identity;
    this.identity = IdentitySchema.parse(rest);
    this.writeAtomic(this.identity);
  }

  /**
   * Start over with a fresh secret and no nodeId — used when an unclaimed
   * node's stored claim code has expired and it must re-register (the old
   * unclaimed row is garbage-collected server-side).
   */
  regenerate(): void {
    this.identity = IdentitySchema.parse({
      nodeSecret: randomBytes(48).toString("base64url"),
    });
    this.log.info("regenerated node identity (previous registration abandoned)");
    this.writeAtomic(this.identity);
  }
}
