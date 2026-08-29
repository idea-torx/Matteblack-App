type ConvertMessage = {
  type: "convert";
  frames: ArrayBuffer[];
  width: number;
  height: number;
  fps: number;
  quality: number;
  loop: boolean;
};

type GifWorkerResponse =
  | { type: "progress"; percent: number; stage: string }
  | { type: "done"; gif: ArrayBuffer; size: number }
  | { type: "error"; message: string };

function rgbToIndexed(
  pixels: Uint8ClampedArray,
  total: number,
  paletteSize: number
): { indexed: Uint8Array; palette: number[][] } {
  const sampleStep = Math.max(1, Math.floor(total / 10000));
  const samples: number[][] = [];
  for (let i = 0; i < total * 4; i += 4 * sampleStep) {
    samples.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
  }

  const palette: number[][] = samples.slice(0, paletteSize);
  while (palette.length < paletteSize) palette.push([0, 0, 0]);

  for (let iter = 0; iter < 4; iter++) {
    const buckets: number[][][] = Array.from({ length: paletteSize }, () => []);
    for (const s of samples) {
      let bestD = Infinity, bestI = 0;
      for (let p = 0; p < palette.length; p++) {
        const dr = s[0] - palette[p][0], dg = s[1] - palette[p][1], db = s[2] - palette[p][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; bestI = p; }
      }
      buckets[bestI].push(s);
    }
    for (let p = 0; p < paletteSize; p++) {
      if (buckets[p].length === 0) continue;
      let r = 0, g = 0, b = 0;
      for (const c of buckets[p]) { r += c[0]; g += c[1]; b += c[2]; }
      const n = buckets[p].length;
      palette[p] = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    }
  }

  const indexed = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const pi = i * 4;
    const r = pixels[pi], g = pixels[pi + 1], b = pixels[pi + 2];
    let bestD = Infinity, bestI = 0;
    for (let p = 0; p < palette.length; p++) {
      const dr = r - palette[p][0], dg = g - palette[p][1], db = b - palette[p][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; bestI = p; }
    }
    indexed[i] = bestI;
  }

  return { indexed, palette };
}

function lzwEncode(indexed: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const output: number[] = [];
  let bitBuf = 0, bitCount = 0;

  function writeBits(code: number, bits: number) {
    bitBuf |= code << bitCount;
    bitCount += bits;
    while (bitCount >= 8) {
      output.push(bitBuf & 0xff);
      bitBuf >>= 8;
      bitCount -= 8;
    }
  }

  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  const table = new Map<string, number>();
  for (let i = 0; i < clearCode; i++) table.set(String(i), i);

  writeBits(clearCode, codeSize);
  let current = String(indexed[0]);

  for (let i = 1; i < indexed.length; i++) {
    const next = String(indexed[i]);
    const combined = current + "," + next;
    if (table.has(combined)) {
      current = combined;
    } else {
      writeBits(table.get(current)!, codeSize);
      if (nextCode < 4096) {
        table.set(combined, nextCode++);
        if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
      } else {
        writeBits(clearCode, codeSize);
        table.clear();
        for (let j = 0; j < clearCode; j++) table.set(String(j), j);
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
      }
      current = next;
    }
  }

  writeBits(table.get(current)!, codeSize);
  writeBits(eoiCode, codeSize);
  if (bitCount > 0) output.push(bitBuf & 0xff);
  return new Uint8Array(output);
}

function buildGif(
  frames: { indexed: Uint8Array; palette: number[][] }[],
  w: number, h: number,
  delay: number, loopFlag: boolean, paletteSize: number
): ArrayBuffer {
  const parts: number[] = [];
  parts.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);

  const colorBits = Math.ceil(Math.log2(paletteSize));
  parts.push(w & 0xff, (w >> 8) & 0xff);
  parts.push(h & 0xff, (h >> 8) & 0xff);
  parts.push(0x70);
  parts.push(0, 0);

  if (loopFlag) {
    parts.push(0x21, 0xff, 0x0b);
    const ns = "NETSCAPE2.0";
    for (let i = 0; i < ns.length; i++) parts.push(ns.charCodeAt(i));
    parts.push(3, 1, 0, 0, 0);
  }

  const delayCs = Math.round(delay / 10);

  for (const frame of frames) {
    parts.push(0x21, 0xf9, 0x04, 0x00);
    parts.push(delayCs & 0xff, (delayCs >> 8) & 0xff);
    parts.push(0, 0);

    const lctBits = colorBits;
    const lctSize = 1 << lctBits;
    parts.push(0x2c);
    parts.push(0, 0, 0, 0);
    parts.push(w & 0xff, (w >> 8) & 0xff);
    parts.push(h & 0xff, (h >> 8) & 0xff);
    parts.push(0x80 | ((lctBits - 1) & 0x07));

    for (let i = 0; i < lctSize; i++) {
      if (i < frame.palette.length) {
        parts.push(frame.palette[i][0], frame.palette[i][1], frame.palette[i][2]);
      } else {
        parts.push(0, 0, 0);
      }
    }

    const minCodeSize = Math.max(2, lctBits);
    parts.push(minCodeSize);
    const lzwData = lzwEncode(frame.indexed, minCodeSize);
    let offset = 0;
    while (offset < lzwData.length) {
      const chunkSize = Math.min(255, lzwData.length - offset);
      parts.push(chunkSize);
      for (let i = 0; i < chunkSize; i++) parts.push(lzwData[offset + i]);
      offset += chunkSize;
    }
    parts.push(0);
  }

  parts.push(0x3b);
  return new Uint8Array(parts).buffer;
}

self.onmessage = (e: MessageEvent<ConvertMessage>) => {
  const msg = e.data;
  if (msg.type !== "convert") return;

  const post = (resp: GifWorkerResponse) => self.postMessage(resp);

  try {
    const { frames, width, height, fps, quality, loop } = msg;
    const totalFrames = frames.length;
    const paletteSize = quality >= 80 ? 256 : quality >= 50 ? 128 : 64;

    post({ type: "progress", percent: 10, stage: "Quantizing colors..." });

    const quantizedFrames: { indexed: Uint8Array; palette: number[][] }[] = [];

    for (let i = 0; i < totalFrames; i++) {
      const pixels = new Uint8ClampedArray(frames[i]);
      const { indexed, palette } = rgbToIndexed(pixels, width * height, paletteSize);
      quantizedFrames.push({ indexed, palette });

      const pct = 10 + Math.round((i / totalFrames) * 70);
      if (i % 3 === 0 || i === totalFrames - 1) {
        post({ type: "progress", percent: pct, stage: `Processing frame ${i + 1}/${totalFrames}` });
      }
    }

    post({ type: "progress", percent: 85, stage: "Encoding GIF..." });

    const delayMs = Math.round(1000 / fps);
    const gifBuffer = buildGif(quantizedFrames, width, height, delayMs, loop, paletteSize);

    post({ type: "progress", percent: 100, stage: "Complete!" });
    post({ type: "done", gif: gifBuffer, size: gifBuffer.byteLength });
  } catch (err: any) {
    post({ type: "error", message: err?.message || "GIF encoding failed" });
  }
};
