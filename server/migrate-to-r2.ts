import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./db.js";
import { s3, R2_BUCKET_NAME } from "./storage.js";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import mime from "mime-types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || "").replace(/\/$/, "");

async function uploadDirectory(dirPath: string, prefix: string = "") {
  if (!fs.existsSync(dirPath)) {
    console.log(`Directory ${dirPath} does not exist, skipping.`);
    return 0;
  }

  let count = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      count += await uploadDirectory(fullPath, key);
    } else if (entry.isFile()) {
      const contentType = mime.lookup(entry.name) || "application/octet-stream";
      const body = fs.readFileSync(fullPath);

      try {
        await s3.send(new PutObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: key,
          Body: body,
          ContentType: contentType,
        }));
        count++;
        if (count % 50 === 0) {
          console.log(`  Uploaded ${count} files...`);
        }
      } catch (err) {
        console.error(`  Failed to upload ${key}:`, err);
      }
    }
  }

  return count;
}

async function updateDatabaseUrls() {
  const urlColumns = [
    { table: "assets", columns: ["file_url"] },
    { table: "audio_assets", columns: ["file_url"] },
    { table: "canvas_nodes", columns: ["src"] },
    { table: "audio_clips", columns: ["audio_url"] },
    { table: "platform_items", columns: ["thumbnail_url"] },
    { table: "platform_item_contents", columns: ["file_url", "thumbnail_url"] },
    { table: "clearcheck_audits", columns: ["image_file_url", "report_file_url"] },
    { table: "styles", columns: ["image_url"] },
  ];

  let totalUpdated = 0;

  for (const { table, columns } of urlColumns) {
    for (const column of columns) {
      try {
        const result = await pool.query(
          `UPDATE ${table} SET ${column} = CONCAT($1::text, '/', SUBSTRING(${column} FROM 10))
           WHERE ${column} LIKE '/uploads/%'
           RETURNING id`,
          [R2_PUBLIC_URL]
        );
        if (result.rowCount && result.rowCount > 0) {
          console.log(`  Updated ${result.rowCount} rows in ${table}.${column}`);
          totalUpdated += result.rowCount;
        }
      } catch (err) {
        console.error(`  Error updating ${table}.${column}:`, err);
      }
    }
  }

  try {
    const axiomsResult = await pool.query(
      `SELECT id, images FROM axioms WHERE images::text LIKE '%/uploads/%'`
    );
    let axiomCount = 0;
    for (const row of axiomsResult.rows) {
      const images = row.images as unknown[];
      let changed = false;
      const updated = (Array.isArray(images) ? images : []).map((img: any) => {
        if (typeof img === "string" && img.startsWith("/uploads/")) {
          changed = true;
          return `${R2_PUBLIC_URL}/${img.slice("/uploads/".length)}`;
        }
        if (typeof img === "object" && img !== null && typeof img.url === "string" && img.url.startsWith("/uploads/")) {
          changed = true;
          return { ...img, url: `${R2_PUBLIC_URL}/${img.url.slice("/uploads/".length)}` };
        }
        return img;
      });
      if (changed) {
        await pool.query(`UPDATE axioms SET images = $1::jsonb WHERE id = $2`, [JSON.stringify(updated), row.id]);
        axiomCount++;
      }
    }
    if (axiomCount > 0) {
      console.log(`  Updated ${axiomCount} rows in axioms.images (JSONB)`);
      totalUpdated += axiomCount;
    }
  } catch (err) {
    console.error(`  Error updating axioms.images:`, err);
  }

  return totalUpdated;
}

async function migrate() {
  console.log("=== R2 Migration Start ===");
  console.log(`Uploads dir: ${UPLOADS_DIR}`);
  console.log(`R2 public URL: ${R2_PUBLIC_URL}`);
  console.log("");

  console.log("Step 1: Uploading local files to R2...");
  const fileCount = await uploadDirectory(UPLOADS_DIR);
  console.log(`  Done. Uploaded ${fileCount} files to R2.`);
  console.log("");

  console.log("Step 2: Updating database URLs...");
  const urlCount = await updateDatabaseUrls();
  console.log(`  Done. Updated ${urlCount} database rows.`);
  console.log("");

  console.log("Step 3: Verification — checking for remaining /uploads/ URLs...");
  const verifyColumns = [
    { table: "assets", column: "file_url" },
    { table: "audio_assets", column: "file_url" },
    { table: "canvas_nodes", column: "src" },
    { table: "audio_clips", column: "audio_url" },
    { table: "platform_items", column: "thumbnail_url" },
    { table: "platform_item_contents", column: "file_url" },
    { table: "platform_item_contents", column: "thumbnail_url" },
    { table: "clearcheck_audits", column: "image_file_url" },
    { table: "clearcheck_audits", column: "report_file_url" },
    { table: "styles", column: "image_url" },
  ];
  let remaining = 0;
  for (const { table, column } of verifyColumns) {
    try {
      const r = await pool.query(`SELECT COUNT(*) FROM ${table} WHERE ${column} LIKE '/uploads/%'`);
      const count = parseInt(r.rows[0].count);
      if (count > 0) {
        console.log(`  WARNING: ${count} remaining /uploads/ URLs in ${table}.${column}`);
        remaining += count;
      }
    } catch {}
  }
  try {
    const r = await pool.query(`SELECT COUNT(*) FROM axioms WHERE images::text LIKE '%/uploads/%'`);
    const count = parseInt(r.rows[0].count);
    if (count > 0) {
      console.log(`  WARNING: ${count} remaining /uploads/ URLs in axioms.images (JSONB)`);
      remaining += count;
    }
  } catch {}
  if (remaining === 0) {
    console.log("  All clear — no remaining /uploads/ URLs found in the database.");
  } else {
    console.log(`  ${remaining} total remaining /uploads/ references.`);
  }
  console.log("");

  console.log("=== R2 Migration Complete ===");
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
