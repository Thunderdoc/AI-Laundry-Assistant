/**
 * Embedded sample-photo tests (2026-11-04).
 *
 * The "Try a sample photo" picker ships its JPGs as base64 data URLs in
 * src/sampleImages.ts because the GitHub push carries UTF-8 text only —
 * the binary files themselves can never land in the repo. These tests pin
 * the embedded payloads to the verified source files: every sample must
 * decode to exactly the byte length of its public/samples/*.jpg original
 * and start with the JPEG magic bytes (FF D8), so a corrupted or truncated
 * paste fails here instead of 404ing/breaking in the live picker.
 */
import { describe, expect, it } from "vitest";
import { SAMPLE_IMAGES, sampleImageFile } from "../src/sampleImages";

// Byte lengths of the verified local files in frontend/public/samples/
// (md5s recorded in EXTRA-FEATURES.md / the fix report).
const EXPECTED_LENGTHS: Record<string, number> = {
  cotton: 7099,
  denim: 11968,
  silk: 9916,
  wool: 18424,
};

function decode(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

describe("embedded sample photos", () => {
  it("ships exactly the four verified samples", () => {
    expect(SAMPLE_IMAGES.map((s) => s.id)).toEqual(["cotton", "denim", "silk", "wool"]);
  });

  it.each(["cotton", "denim", "silk", "wool"])(
    "%s decodes to a JPEG of the exact verified byte length",
    (id) => {
      const sample = SAMPLE_IMAGES.find((s) => s.id === id);
      expect(sample).toBeDefined();
      expect(sample!.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
      const bytes = decode(sample!.dataUrl);
      expect(bytes.length).toBe(EXPECTED_LENGTHS[id]);
      // JPEG magic: SOI marker FF D8, followed by a marker start FF.
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1]).toBe(0xd8);
      expect(bytes[2]).toBe(0xff);
    },
  );

  it("sampleImageFile rebuilds a correctly named JPEG File", async () => {
    for (const sample of SAMPLE_IMAGES) {
      const file = sampleImageFile(sample);
      expect(file.name).toBe(sample.fileName);
      expect(file.type).toBe("image/jpeg");
      expect(file.size).toBe(EXPECTED_LENGTHS[sample.id]);
      const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
      expect(head[0]).toBe(0xff);
      expect(head[1]).toBe(0xd8);
    }
  });
});
