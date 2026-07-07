// Unit tests for vision-attachment image compression.
//
// compressImageToFit downscales/re-encodes an oversized raster image to a JPEG
// under an injected byte limit; visionImageDataUrl orchestrates the on-disk
// cache so the derived JPEG is computed once and reused across replay turns.
// Tests are hermetic: the source image is generated in-memory with sharp and
// the limits are small injected values (no real 5 MB files, no network).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { storeUpload } from "../state/uploads";
import { uploadsDir } from "../paths";
import { compressImageToFit, visionImageDataUrl } from "./image-compress";

// A photo-like raster: a color gradient plus deterministic per-pixel noise. It
// compresses (unlike pure random noise, which is pathologically incompressible
// and would never reach a small limit), but not trivially, so a modest injected
// limit forces the quality-step + resize loop to run several iterations. The
// noise is seeded so the produced sizes are stable across runs (no flakiness).
async function photoLikePng(width: number, height: number): Promise<Uint8Array> {
  const raw = Buffer.alloc(width * height * 3);
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      raw[o] = ((x * 255) / width + rnd() * 40) & 255;
      raw[o + 1] = ((y * 255) / height + rnd() * 40) & 255;
      raw[o + 2] = (((x + y) * 255) / (width + height) + rnd() * 40) & 255;
    }
  }
  const out = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  return new Uint8Array(out);
}

describe("compressImageToFit", () => {
  test("compresses an oversized raster to a valid JPEG under the limit", async () => {
    const png = await photoLikePng(800, 800);
    const limit = 120_000;
    expect(png.length).toBeGreaterThan(limit);

    const result = await compressImageToFit(png, "image/png", limit);
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe("image/jpeg");
    expect(result!.bytes.length).toBeLessThanOrEqual(limit);

    // Output is a decodable JPEG.
    const meta = await sharp(result!.bytes).metadata();
    expect(meta.format).toBe("jpeg");
  });

  test("returns under-limit input unchanged", async () => {
    const png = await photoLikePng(8, 8);
    const limit = 5_000_000;
    expect(png.length).toBeLessThanOrEqual(limit);

    const result = await compressImageToFit(png, "image/png", limit);
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe("image/png");
    expect(result!.bytes).toBe(png); // same reference, untouched
  });

  test("returns null for undecodable bytes", async () => {
    const garbage = new Uint8Array([1, 2, 3, 4]);
    const result = await compressImageToFit(garbage, "image/png", 2);
    expect(result).toBeNull();
  });

  test("exhausts the ladder gracefully under a pathologically tiny limit", async () => {
    const png = await photoLikePng(800, 800);
    const limit = 100;
    expect(png.length).toBeGreaterThan(limit);

    // No JPEG of a real raster fits in 100 bytes, so the ladder runs to the end
    // and returns its smallest best-effort JPEG — non-null, decodable, but still
    // over the limit. The over-limit guard lives in visionImageDataUrl.
    const result = await compressImageToFit(png, "image/png", limit);
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe("image/jpeg");
    expect(result!.bytes.length).toBeGreaterThan(limit);
    const meta = await sharp(result!.bytes).metadata();
    expect(meta.format).toBe("jpeg");
  });
});

describe("visionImageDataUrl", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;
  const instance = "img-compress-test";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-img-compress-state-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}-logs`, { recursive: true, force: true });
  });

  test("compresses once, caches the JPEG, and reuses it", async () => {
    const png = await photoLikePng(800, 800);
    const limit = 120_000;
    const upload = storeUpload(instance, png, "image/png", "photo.png");

    const first = await visionImageDataUrl(instance, upload.id, limit);
    expect(first).not.toBeNull();
    expect(first!.startsWith("data:image/jpeg;base64,")).toBe(true);

    // Derived JPEG cached on disk keyed by (id, limit).
    const cachePath = join(uploadsDir(instance), `${upload.id}.vis-${limit}.jpg`);
    expect(existsSync(cachePath)).toBe(true);

    // Second call returns the same data URL from the cache.
    const second = await visionImageDataUrl(instance, upload.id, limit);
    expect(second).toBe(first);
  });

  test("returns the original data url untouched when under the limit", async () => {
    const png = await photoLikePng(8, 8);
    const upload = storeUpload(instance, png, "image/png", "tiny.png");

    const url = await visionImageDataUrl(instance, upload.id, 5_000_000);
    expect(url).not.toBeNull();
    expect(url!.startsWith("data:image/png;base64,")).toBe(true);
    // No vision variant written for an under-limit image.
    expect(existsSync(join(uploadsDir(instance), `${upload.id}.vis-5000000.jpg`))).toBe(false);
  });

  test("returns null when the image can't be compressed under a tiny limit", async () => {
    const png = await photoLikePng(800, 800);
    const limit = 100; // no real-raster JPEG fits — over-limit guard drops it.
    const upload = storeUpload(instance, png, "image/png", "photo.png");

    const url = await visionImageDataUrl(instance, upload.id, limit);
    expect(url).toBeNull();
    // No over-limit variant cached: nothing was emitted.
    expect(existsSync(join(uploadsDir(instance), `${upload.id}.vis-${limit}.jpg`))).toBe(false);
  });

  test("returns null for a missing upload", async () => {
    const url = await visionImageDataUrl(instance, "does-not-exist", 5_000_000);
    expect(url).toBeNull();
  });
});
