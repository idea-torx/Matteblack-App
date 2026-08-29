import type { Request, Response } from "express";
import type { Pool } from "pg";
import { URL } from "url";
import dns from "dns/promises";
import net from "net";
import { saveFile } from "./storage.js";
import { checkAndDebit, refundCreditsWithFallback } from "./credits/creditGate.js";

interface AuthRequest extends Request {
  userId?: string;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("fe80")) return true;
    if (lower.startsWith("::ffff:")) {
      const v4 = lower.slice(7);
      if (net.isIPv4(v4)) return isPrivateIp(v4);
    }
    return false;
  }
  return true;
}

async function validateAndFetchUrl(rawUrl: string): Promise<Buffer> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:") {
    throw new Error("Only HTTPS URLs are accepted");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".arpa")
  ) {
    throw new Error("Disallowed hostname");
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error("Disallowed IP address");
    }
  } else {
    const addresses = await dns.resolve4(hostname).catch(() => [] as string[]);
    const addresses6 = await dns.resolve6(hostname).catch(() => [] as string[]);
    const allIps = [...addresses, ...addresses6];

    if (allIps.length === 0) {
      throw new Error("Could not resolve hostname");
    }

    for (const ip of allIps) {
      if (isPrivateIp(ip)) {
        throw new Error("Hostname resolves to a private IP address");
      }
    }
  }

  const resp = await fetch(rawUrl, { redirect: "error" });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) {
    throw new Error("URL does not point to an image");
  }

  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

export async function handleClearcheck(req: AuthRequest, res: Response, pool: Pool) {
  const {
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    AWS_REGION,
  } = process.env;

  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_REGION) {
    res.status(500).json({
      error:
        "AWS credentials are not configured. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION environment variables.",
    });
    return;
  }

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { imageBase64, imageUrl, options } = req.body as {
    imageBase64?: string;
    imageUrl?: string;
    options?: {
      labels?: boolean;
      moderation?: boolean;
      text?: boolean;
      faces?: boolean;
      celebrities?: boolean;
    };
  };

  if (!imageBase64 && !imageUrl) {
    res.status(400).json({ error: "Either imageBase64 or imageUrl is required" });
    return;
  }

  const opts = options || { labels: true, moderation: true, text: true, faces: false, celebrities: false };
  if (!opts.labels && !opts.moderation && !opts.text && !opts.faces && !opts.celebrities) {
    res.status(400).json({ error: "At least one analysis option must be enabled" });
    return;
  }

  let imageBytes: Buffer;
  try {
    if (imageBase64) {
      const base64Data = imageBase64.includes(",")
        ? imageBase64.split(",")[1]
        : imageBase64;
      imageBytes = Buffer.from(base64Data, "base64");
    } else {
      const parsed = new URL(imageUrl!);
      const isLocalAsset = parsed.pathname.startsWith("/api/assets") ||
        parsed.pathname.startsWith("/uploads/") ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1";

      if (isLocalAsset) {
        const localPort = process.env.PORT || "3001";
        const localUrl = `http://127.0.0.1:${localPort}${parsed.pathname}${parsed.search}`;
        const localResp = await fetch(localUrl);
        if (!localResp.ok) throw new Error(`Local fetch failed: HTTP ${localResp.status}`);
        imageBytes = Buffer.from(await localResp.arrayBuffer());
      } else {
        imageBytes = await validateAndFetchUrl(imageUrl!);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to read image data";
    res.status(400).json({ error: msg });
    return;
  }

  if (imageBytes.length === 0) {
    res.status(400).json({ error: "Image data is empty" });
    return;
  }

  const clearcheckWorkspaceId = req.body.workspace_id;
  const debitResult = await checkAndDebit(userId, "clearcheck", 1, undefined, clearcheckWorkspaceId || undefined);
  if (!debitResult.success) {
    const status = debitResult.retryAfterSeconds ? 429 : debitResult.required ? 402 : 400;
    res.status(status).json({
      error: debitResult.error,
      required: debitResult.required,
      balance: debitResult.balance,
      retryAfterSeconds: debitResult.retryAfterSeconds,
    });
    return;
  }

  try {
    const { RekognitionClient, DetectLabelsCommand, DetectModerationLabelsCommand, DetectTextCommand, DetectFacesCommand, RecognizeCelebritiesCommand } =
      await import("@aws-sdk/client-rekognition");

    const client = new RekognitionClient({
      region: AWS_REGION,
      credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
      },
    });

    const imageParam = { Image: { Bytes: imageBytes } };

    const labels: { name: string; confidence: number }[] = [];
    const moderationFlags: string[] = [];
    const textDetections: { text: string; confidence: number }[] = [];
    const faceDetails: { confidence: number; ageRange?: string; gender?: string; emotions?: string[] }[] = [];
    const celebrities: { name: string; confidence: number }[] = [];

    const promises: Promise<void>[] = [];

    if (opts.labels) {
      promises.push(
        client
          .send(new DetectLabelsCommand({ ...imageParam, MaxLabels: 20 }))
          .then((r) => {
            for (const l of r.Labels || []) {
              if (l.Name && l.Confidence !== undefined) {
                labels.push({
                  name: l.Name,
                  confidence: Math.round(l.Confidence * 10) / 10,
                });
              }
            }
          })
      );
    }

    if (opts.moderation) {
      promises.push(
        client
          .send(new DetectModerationLabelsCommand(imageParam))
          .then((r) => {
            for (const m of r.ModerationLabels || []) {
              if (m.Name) {
                const conf =
                  m.Confidence !== undefined
                    ? ` (${Math.round(m.Confidence * 10) / 10}%)`
                    : "";
                moderationFlags.push(`${m.Name}${conf}`);
              }
            }
          })
      );
    }

    if (opts.text) {
      promises.push(
        client.send(new DetectTextCommand(imageParam)).then((r) => {
          for (const t of r.TextDetections || []) {
            if (t.Type === "LINE" && t.DetectedText && t.Confidence !== undefined) {
              textDetections.push({
                text: t.DetectedText,
                confidence: Math.round(t.Confidence * 10) / 10,
              });
            }
          }
        })
      );
    }

    if (opts.faces) {
      promises.push(
        client
          .send(new DetectFacesCommand({ ...imageParam, Attributes: ["ALL"] }))
          .then((r) => {
            for (const f of r.FaceDetails || []) {
              const detail: typeof faceDetails[number] = {
                confidence: Math.round((f.Confidence || 0) * 10) / 10,
              };
              if (f.AgeRange) {
                detail.ageRange = `${f.AgeRange.Low}-${f.AgeRange.High}`;
              }
              if (f.Gender?.Value) {
                detail.gender = f.Gender.Value;
              }
              if (f.Emotions) {
                detail.emotions = f.Emotions.filter(
                  (e) => (e.Confidence || 0) > 50
                ).map((e) => e.Type || "");
              }
              faceDetails.push(detail);
            }
          })
      );
    }

    if (opts.celebrities) {
      promises.push(
        client
          .send(new RecognizeCelebritiesCommand(imageParam))
          .then((r) => {
            for (const c of r.CelebrityFaces || []) {
              if (c.Name && c.MatchConfidence !== undefined) {
                celebrities.push({
                  name: c.Name,
                  confidence: Math.round(c.MatchConfidence * 10) / 10,
                });
              }
            }
          })
      );
    }

    await Promise.all(promises);

    const hasModerationIssues = moderationFlags.length > 0;
    const hasCelebrities = celebrities.length > 0;
    const status: "clear" | "flagged" =
      hasModerationIssues || hasCelebrities ? "flagged" : "clear";

    const allLabels = [
      ...labels,
      ...celebrities.map((c) => ({
        name: `Celebrity: ${c.name}`,
        confidence: c.confidence,
      })),
      ...textDetections.map((t) => ({
        name: `Text: "${t.text}"`,
        confidence: t.confidence,
      })),
      ...faceDetails.map((f, i) => ({
        name: `Face #${i + 1}${f.gender ? ` (${f.gender})` : ""}${f.ageRange ? ` age ${f.ageRange}` : ""}`,
        confidence: f.confidence,
      })),
    ];

    if (hasCelebrities) {
      moderationFlags.push(
        ...celebrities.map(
          (c) =>
            `Celebrity detected: ${c.name} (${c.confidence}%) — verify licensing`
        )
      );
    }

    const timestamp = Date.now();
    const fileName = (req.body as { fileName?: string }).fileName || "image.png";

    let imageFileUrl: string | null = null;
    let reportFileUrl: string | null = null;

    try {
      const ext = fileName.split(".").pop() || "png";
      const imageFileName = `${timestamp}.${ext}`;
      imageFileUrl = await saveFile(`users/${userId}/clearcheck`, imageFileName, imageBytes);

      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();

      const mdLines = [
        "# Clearcheck Copyright Audit Report",
        "",
        `**Date:** ${new Date(timestamp).toISOString()}`,
        `**File:** ${fileName}`,
        `**Status:** ${status === "clear" ? "CLEAR" : "FLAGGED"}`,
        "",
        "## Detected Labels",
        "",
        ...allLabels.map((l) => `- ${l.name}: ${l.confidence.toFixed(1)}%`),
        "",
      ];
      if (moderationFlags.length > 0) {
        mdLines.push("## Moderation Flags", "", ...moderationFlags.map((f) => `- ${f}`), "");
      }
      mdLines.push("---", "*Generated by Clearcheck*");
      zip.file(`clearcheck-report-${timestamp}.md`, mdLines.join("\n"));
      zip.file(imageFileName, imageBytes);

      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
      reportFileUrl = await saveFile(`users/${userId}/clearcheck`, `report-${timestamp}.zip`, zipBuffer);
    } catch (fileErr) {
      console.error("Failed to save clearcheck files:", fileErr);
    }

    let auditId: string | null = null;
    try {
      const insertResult = await pool.query(
        `INSERT INTO clearcheck_audits (user_id, source, file_name, status, labels, moderation_flags, image_file_url, report_file_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [userId, (req.body as { source?: string }).source || "upload", fileName, status, JSON.stringify(allLabels), JSON.stringify(moderationFlags), imageFileUrl, reportFileUrl]
      );
      auditId = insertResult.rows[0].id;
    } catch (dbErr) {
      console.error("Failed to insert clearcheck audit:", dbErr);
    }

    res.json({
      labels: allLabels,
      moderationFlags,
      status,
      timestamp,
      auditId,
    });
  } catch (err: unknown) {
    console.error("Clearcheck analysis error:", err);
    if (debitResult.cost > 0) {
      await refundCreditsWithFallback(userId, debitResult.cost, "clearcheck_failed", debitResult.ledgerId, clearcheckWorkspaceId || undefined);
    }
    res.status(500).json({ error: "Image analysis failed. Please try again." });
  }
}
