/**
 * Custom-model API: discover a model on fal.ai and add it to Falforge.
 *
 * Same auth shape as the skills routes — the paired MCP process (loopback +
 * per-boot token) or a signed-in user. Custom models are a JSON file in the
 * user's own data dir, so there is nothing further to scope them to.
 */
import { Router, type Response, type NextFunction } from "express";
import { requireAuth, type AuthRequest } from "../sessions.js";
import { getMcpToken } from "../mcpToken.js";
import { searchModels, getModelSchema } from "../services/falCatalog.js";
import {
  listCustomModels, addCustomModel, removeCustomModel, keyFromEndpoint,
  type CustomModel, type CustomModelType,
} from "../models/customModels.js";

const router = Router();

function allowMcpOrUser(req: AuthRequest, res: Response, next: NextFunction): void {
  const expected = getMcpToken();
  if (process.env.MB_MCP_NO_TOKEN === "1") { next(); return; }
  if (expected && req.header("x-matteblack-token") === expected) { next(); return; }
  requireAuth(req, res, next);
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

router.get("/api/models/custom", allowMcpOrUser, (_req: AuthRequest, res) => {
  res.json({ models: listCustomModels() });
});

router.get("/api/models/search", allowMcpOrUser, async (req: AuthRequest, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) { res.status(400).json({ error: "q is required." }); return; }
  try {
    res.json({ results: await searchModels(q) });
  } catch (err) {
    res.status(502).json({ error: `fal model search failed: ${errMsg(err)}` });
  }
});

router.get("/api/models/schema", allowMcpOrUser, async (req: AuthRequest, res) => {
  const endpoint = String(req.query.endpoint ?? "").trim();
  if (!endpoint) { res.status(400).json({ error: "endpoint is required." }); return; }
  try {
    res.json(await getModelSchema(endpoint));
  } catch (err) {
    res.status(502).json({ error: `Could not read the schema for "${endpoint}": ${errMsg(err)}` });
  }
});

router.post("/api/models/custom", allowMcpOrUser, async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const endpointId = typeof body.endpointId === "string" ? body.endpointId.trim() : "";
  if (!endpointId) { res.status(400).json({ error: "endpointId is required (e.g. \"fal-ai/flux/schnell\")." }); return; }
  const key = keyFromEndpoint(typeof body.key === "string" && body.key.trim() ? body.key : endpointId);
  if (!key) { res.status(400).json({ error: "Invalid model key." }); return; }
  try {
    const s = await getModelSchema(endpointId);
    const type = (["image", "video", "audio"] as const).includes(body.type as CustomModelType)
      ? (body.type as CustomModelType)
      : s.type;
    const model: CustomModel = {
      key,
      falModelId: s.endpointId,
      type,
      title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : s.endpointId,
      schema: s.input,
      defaults: (body.defaults && typeof body.defaults === "object" ? body.defaults : {}) as Record<string, unknown>,
      addedAt: new Date().toISOString(),
      addedBy: req.header("x-falforge-actor") === "operator" ? "operator" : "user",
    };
    res.json({ model: addCustomModel(model) });
  } catch (err) {
    res.status(502).json({ error: `Could not add "${endpointId}": ${errMsg(err)}` });
  }
});

router.delete("/api/models/custom/:key", allowMcpOrUser, (req: AuthRequest, res) => {
  if (!removeCustomModel(String(req.params.key))) { res.status(404).json({ error: "No such custom model." }); return; }
  res.json({ ok: true });
});

export default router;
