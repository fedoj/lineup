/**
 * Limits for pictures people upload. Photos are shrunk on the phone before
 * they are sent (see apps/web/src/lib/image.ts), so these are what arrives at
 * the server and is kept in the database.
 */

/** An event flyer: a photo (shrunk to fit) or a PDF. */
export const FLYER_MAX_BYTES = 512 * 1024;
/** Longest side, in pixels, a flyer photo is shrunk to; text stays readable. */
export const FLYER_IMAGE_MAX_SIDE = 1400;

/** "0.25 MB", "3 MB", "195 KB": a size limit as people read it. */
export function sizeLabel(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 0.25) return `${Number.parseFloat(mb.toFixed(2))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
