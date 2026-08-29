import { Router, Request, Response } from "express";
import { pool } from "../db.js";
import multer from "multer";
import { saveFile, deleteFile } from "../storage.js";
import { v4 as uuidv4 } from "uuid";
import path from "path";

interface AuthRequest extends Request {
  userId?: string;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const r2Host = (() => {
  try {
    return process.env.R2_PUBLIC_URL ? new URL(process.env.R2_PUBLIC_URL).hostname : null;
  } catch { return null; }
})();

const ALLOWED_PROXY_DOMAINS = [
  "fal.media",
  "v3.fal.media",
  "storage.googleapis.com",
  "cdn.fal.ai",
  ...(r2Host ? [r2Host] : []),
];

const router = Router();

router.get("/api/audio-proxy", async (req: Request, res: Response) => {
  const rawUrl = req.query.url as string | undefined;
  if (!rawUrl) {
    res.status(400).json({ error: { code: "MISSING_URL", message: "url query parameter is required" } });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    res.status(400).json({ error: { code: "INVALID_URL", message: "Invalid URL" } });
    return;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    res.status(400).json({ error: { code: "INVALID_PROTOCOL", message: "Only HTTP(S) URLs are allowed" } });
    return;
  }

  const domainAllowed = ALLOWED_PROXY_DOMAINS.some(
    (d) => parsed.hostname === d || parsed.hostname.endsWith(`.${d}`)
  );
  if (!domainAllowed) {
    res.status(403).json({ error: { code: "DOMAIN_NOT_ALLOWED", message: `Domain '${parsed.hostname}' is not in the allowlist` } });
    return;
  }

  try {
    const upstreamHeaders: Record<string, string> = { Accept: "audio/*,*/*" };
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      upstreamHeaders["Range"] = rangeHeader;
    }

    const upstream = await fetch(rawUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });

    const finalUrl = upstream.url;
    if (finalUrl && finalUrl !== rawUrl) {
      try {
        const finalParsed = new URL(finalUrl);
        const finalAllowed = ALLOWED_PROXY_DOMAINS.some(
          (d) => finalParsed.hostname === d || finalParsed.hostname.endsWith(`.${d}`)
        );
        if (!finalAllowed) {
          res.status(403).json({ error: { code: "REDIRECT_NOT_ALLOWED", message: `Redirect target '${finalParsed.hostname}' is not in the allowlist` } });
          return;
        }
      } catch {
        res.status(400).json({ error: { code: "INVALID_REDIRECT", message: "Invalid redirect URL" } });
        return;
      }
    }

    if (!upstream.ok && upstream.status !== 206) {
      res.status(upstream.status).json({ error: { code: "UPSTREAM_ERROR", message: `Upstream returned ${upstream.status}` } });
      return;
    }

    const contentType = upstream.headers.get("content-type") || "audio/mpeg";
    const contentLength = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");
    const acceptRanges = upstream.headers.get("accept-ranges");

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }
    if (acceptRanges) {
      res.setHeader("Accept-Ranges", acceptRanges);
    }
    if (contentRange) {
      res.setHeader("Content-Range", contentRange);
    }

    res.status(upstream.status);

    const body = upstream.body;
    if (!body) {
      res.status(502).json({ error: { code: "NO_BODY", message: "Upstream returned no body" } });
      return;
    }

    const reader = body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.writableEnded) {
          res.write(Buffer.from(value));
        }
      }
      if (!res.writableEnded) {
        res.end();
      }
    };

    pump().catch((err) => {
      console.error("Audio proxy stream error:", err);
      if (!res.headersSent) {
        res.status(502).json({ error: { code: "STREAM_ERROR", message: "Error streaming audio" } });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  } catch (err) {
    console.error("Audio proxy error:", err);
    res.status(502).json({ error: { code: "PROXY_ERROR", message: "Failed to fetch audio from upstream" } });
  }
});

router.get("/api/media-proxy", async (req: Request, res: Response) => {
  const rawUrl = req.query.url as string | undefined;
  if (!rawUrl) {
    res.status(400).json({ error: { code: "MISSING_URL", message: "url query parameter is required" } });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    res.status(400).json({ error: { code: "INVALID_URL", message: "Invalid URL" } });
    return;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    res.status(400).json({ error: { code: "INVALID_PROTOCOL", message: "Only HTTP(S) URLs are allowed" } });
    return;
  }

  const domainAllowed = ALLOWED_PROXY_DOMAINS.some(
    (d) => parsed.hostname === d || parsed.hostname.endsWith(`.${d}`)
  );
  if (!domainAllowed) {
    res.status(403).json({ error: { code: "DOMAIN_NOT_ALLOWED", message: `Domain '${parsed.hostname}' is not in the allowlist` } });
    return;
  }

  try {
    const upstreamHeaders: Record<string, string> = { Accept: "video/*,*/*" };
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      upstreamHeaders["Range"] = rangeHeader;
    }

    const upstream = await fetch(rawUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });

    const finalUrl = upstream.url;
    if (finalUrl && finalUrl !== rawUrl) {
      try {
        const finalParsed = new URL(finalUrl);
        const finalAllowed = ALLOWED_PROXY_DOMAINS.some(
          (d) => finalParsed.hostname === d || finalParsed.hostname.endsWith(`.${d}`)
        );
        if (!finalAllowed) {
          res.status(403).json({ error: { code: "REDIRECT_NOT_ALLOWED", message: `Redirect target '${finalParsed.hostname}' is not in the allowlist` } });
          return;
        }
      } catch {
        res.status(400).json({ error: { code: "INVALID_REDIRECT", message: "Invalid redirect URL" } });
        return;
      }
    }

    if (!upstream.ok && upstream.status !== 206) {
      res.status(upstream.status).json({ error: { code: "UPSTREAM_ERROR", message: `Upstream returned ${upstream.status}` } });
      return;
    }

    const contentType = upstream.headers.get("content-type") || "video/mp4";
    const contentLength = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");
    const acceptRanges = upstream.headers.get("accept-ranges");

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }
    if (acceptRanges) {
      res.setHeader("Accept-Ranges", acceptRanges);
    }
    if (contentRange) {
      res.setHeader("Content-Range", contentRange);
    }

    res.status(upstream.status);

    const body = upstream.body;
    if (!body) {
      res.status(502).json({ error: { code: "NO_BODY", message: "Upstream returned no body" } });
      return;
    }

    const reader = body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.writableEnded) {
          res.write(Buffer.from(value));
        }
      }
      if (!res.writableEnded) {
        res.end();
      }
    };

    pump().catch((err) => {
      console.error("Media proxy stream error:", err);
      if (!res.headersSent) {
        res.status(502).json({ error: { code: "STREAM_ERROR", message: "Error streaming media" } });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  } catch (err) {
    console.error("Media proxy error:", err);
    res.status(502).json({ error: { code: "PROXY_ERROR", message: "Failed to fetch media from upstream" } });
  }
});

router.get("/api/audio", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { class: audioClass, folder_id, source } = req.query;

    let where = "WHERE user_id = $1 AND deleted_at IS NULL";
    const params: unknown[] = [userId];
    let idx = 2;

    if (audioClass) {
      where += ` AND audio_class = $${idx++}`;
      params.push(audioClass);
    }
    if (folder_id === "null" || folder_id === "unfiled") {
      where += " AND folder_id IS NULL";
    } else if (folder_id) {
      where += ` AND folder_id = $${idx++}`;
      params.push(folder_id);
    }
    if (source) {
      where += ` AND source = $${idx++}`;
      params.push(source);
    }

    const result = await pool.query(
      `SELECT * FROM audio_assets ${where} ORDER BY created_at DESC`,
      params
    );
    res.json({ audio_assets: result.rows });
  } catch (err) {
    console.error("List audio error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to fetch audio assets" } });
  }
});

router.post("/api/audio", upload.single("file"), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { name, audio_class, duration_seconds, metadata, folder_id } = req.body;

    if (!name || !audio_class) {
      res.status(400).json({ error: { code: "MISSING_FIELDS", message: "name and audio_class are required" } });
      return;
    }
    const validClasses = ["music", "voice", "sound_effect"];
    if (!validClasses.includes(audio_class)) {
      res.status(400).json({ error: { code: "INVALID_CLASS", message: "Audio class is required. Must be one of: music, voice, sound_effect." } });
      return;
    }

    let validatedFolderId: string | null = null;
    if (folder_id && folder_id !== "null") {
      const folderCheck = await pool.query(
        "SELECT id, type FROM folders WHERE id = $1 AND user_id = $2",
        [folder_id, userId]
      );
      if (folderCheck.rows.length === 0) {
        res.status(400).json({ error: { code: "INVALID_FOLDER", message: "Folder not found or not owned by you" } });
        return;
      }
      const folderType = folderCheck.rows[0].type;
      if (folderType !== audio_class) {
        res.status(400).json({ error: { code: "FOLDER_TYPE_MISMATCH", message: `Folder type '${folderType}' does not match audio class '${audio_class}'` } });
        return;
      }
      validatedFolderId = folder_id;
    }

    let parsedMetadata = {};
    if (metadata) {
      try {
        parsedMetadata = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
      } catch {
        res.status(400).json({ error: { code: "INVALID_METADATA", message: "metadata must be valid JSON" } });
        return;
      }
    }

    let fileUrl = "";
    let fileType = null;
    if (req.file) {
      const ext = path.extname(req.file.originalname) || ".mp3";
      fileUrl = await saveFile(`users/${userId}`, `audio/${uuidv4()}${ext}`, req.file.buffer);
      fileType = req.file.mimetype;
    }

    const result = await pool.query(
      `INSERT INTO audio_assets (user_id, audio_class, folder_id, name, file_url, file_type, duration_seconds, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [userId, audio_class, validatedFolderId, name, fileUrl, fileType, duration_seconds || null, parsedMetadata]
    );
    res.status(201).json({ audio_asset: result.rows[0] });
  } catch (err) {
    console.error("Create audio error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to create audio asset" } });
  }
});

router.put("/api/audio/:id/folder", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;
    const { folder_id } = req.body;

    let validatedFolderId: string | null = null;
    if (folder_id && folder_id !== "null") {
      const asset = await pool.query("SELECT audio_class FROM audio_assets WHERE id = $1 AND user_id = $2", [id, userId]);
      if (asset.rows.length === 0) {
        res.status(404).json({ error: { code: "NOT_FOUND", message: "Audio asset not found" } });
        return;
      }
      const folderCheck = await pool.query(
        "SELECT id, type FROM folders WHERE id = $1 AND user_id = $2",
        [folder_id, userId]
      );
      if (folderCheck.rows.length === 0) {
        res.status(400).json({ error: { code: "INVALID_FOLDER", message: "Folder not found or not owned by you" } });
        return;
      }
      if (folderCheck.rows[0].type !== asset.rows[0].audio_class) {
        res.status(400).json({ error: { code: "FOLDER_TYPE_MISMATCH", message: `Folder type '${folderCheck.rows[0].type}' does not match audio class '${asset.rows[0].audio_class}'` } });
        return;
      }
      validatedFolderId = folder_id;
    }

    const result = await pool.query(
      "UPDATE audio_assets SET folder_id = $1, updated_at = now() WHERE id = $2 AND user_id = $3 RETURNING *",
      [validatedFolderId, id, userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Audio asset not found" } });
      return;
    }
    res.json({ audio_asset: result.rows[0] });
  } catch (err) {
    console.error("Move audio to folder error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to move audio" } });
  }
});

router.put("/api/audio/:id/class", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;
    const { audio_class } = req.body;

    const validClasses = ["music", "voice", "sound_effect"];
    if (!audio_class || !validClasses.includes(audio_class)) {
      res.status(400).json({ error: { code: "INVALID_CLASS", message: "audio_class must be one of: music, voice, sound_effect" } });
      return;
    }

    const result = await pool.query(
      "UPDATE audio_assets SET audio_class = $1, folder_id = NULL, updated_at = now() WHERE id = $2 AND user_id = $3 RETURNING *",
      [audio_class, id, userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Audio asset not found" } });
      return;
    }
    res.json({ audio_asset: result.rows[0] });
  } catch (err) {
    console.error("Change audio class error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to change audio class" } });
  }
});

router.delete("/api/audio/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;

    const result = await pool.query(
      "UPDATE audio_assets SET deleted_at = now(), folder_id = NULL WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING *",
      [id, userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Audio asset not found" } });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete audio error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to delete audio asset" } });
  }
});

export default router;
