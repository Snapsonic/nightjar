import { z } from "zod";

// "cat" and "dog" are split out of "animal" because they are the animals
// people actually want alerts about, and because a household pet triggering a
// "person" alert is the single most common false positive we see. "animal"
// remains for birds, deer, livestock and anything else the model recognises.
export const EventKind = z.enum([
  "motion",
  "person",
  "vehicle",
  "animal",
  "cat",
  "dog",
  "package",
  "bear",
]);
export type EventKind = z.infer<typeof EventKind>;

export const ClipStatus = z.enum(["local", "uploading", "uploaded", "expired"]);
export type ClipStatus = z.infer<typeof ClipStatus>;

export const Detection = z.object({
  kind: EventKind,
  score: z.number().min(0).max(1),
  /** Normalized [x, y, w, h] in 0..1 image coordinates. */
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  atMs: z.number().int(),
});
export type Detection = z.infer<typeof Detection>;

export const NvrEvent = z.object({
  id: z.string().uuid(),
  cameraId: z.string().uuid(),
  kind: EventKind,
  score: z.number().min(0).max(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  clipStatus: ClipStatus.default("local"),
  thumbnailPath: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type NvrEvent = z.infer<typeof NvrEvent>;
