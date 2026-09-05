import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageAttachments, sessionReferences } from "./referenceFiles.ts";

test("six references survive later turns and reloads, with explicit replacement/clear and path confinement", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mb-references-"));
  const attachments = path.join(root, "attachments");
  const scene = path.join(root, "scene");
  try {
    const urls = Array.from({ length: 6 }, (_, i) => `data:image/png;base64,${Buffer.from(`image ${i}`).toString("base64")}`);
    const originals = await stageAttachments(urls, attachments, root);
    assert.equal(originals.length, 6);
    assert.deepEqual(sessionReferences(scene, originals, attachments), originals);
    const next = await stageAttachments(["data:image/png;base64,bmV4dA=="], attachments, root);
    assert.ok(originals.every((p) => fs.existsSync(p)));
    assert.deepEqual(sessionReferences(scene, undefined, attachments), originals);
    assert.equal(sessionReferences(path.join(root, "other-scene"), undefined, attachments).length, 0);
    assert.deepEqual(await stageAttachments(urls, attachments, root), originals);
    const outside = path.join(root, "outside.png");
    fs.writeFileSync(outside, "private");
    assert.throws(() => sessionReferences(scene, [outside], attachments), /staged image/);
    assert.deepEqual(sessionReferences(scene, undefined, attachments), originals);
    assert.deepEqual(sessionReferences(scene, next, attachments), next);
    assert.deepEqual(sessionReferences(scene, [], attachments), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
