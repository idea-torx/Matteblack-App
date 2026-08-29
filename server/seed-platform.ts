import { pool, initDB } from "./db.js";

async function seed() {
  await initDB();

  const items = [
    {
      type: "axiom_template",
      name: "Character Design Starter Kit",
      slug: "character-design-starter",
      description: "A foundational axiom template for character design — includes reference poses, expressions, and lighting setups.",
      is_free: true,
      is_published: true,
      tags: ["character", "starter", "free"],
      metadata: { category: "character_design", image_count: 4 },
      contents: [
        { name: "Hero Pose Reference", content_type: "axiom", metadata: { pose: "standing", angle: "front" } },
        { name: "Expression Sheet", content_type: "axiom", metadata: { pose: "face", variations: 4 } },
        { name: "Lighting Setup A", content_type: "axiom", metadata: { lighting: "dramatic" } },
        { name: "Turnaround Template", content_type: "axiom", metadata: { pose: "turnaround", angles: 4 } },
      ],
    },
    {
      type: "axiom_template",
      name: "Product Photography Pack",
      slug: "product-photography-pack",
      description: "Professional product photography axiom template — clean backgrounds, studio lighting, multiple angles.",
      is_free: true,
      is_published: true,
      tags: ["product", "photography", "starter", "free"],
      metadata: { category: "product", image_count: 4 },
      contents: [
        { name: "Clean White Background", content_type: "axiom", metadata: { background: "white", lighting: "studio" } },
        { name: "45° Angle Shot", content_type: "axiom", metadata: { angle: "45deg" } },
        { name: "Detail Close-up", content_type: "axiom", metadata: { zoom: "macro" } },
        { name: "Lifestyle Context", content_type: "axiom", metadata: { context: "lifestyle" } },
      ],
    },
    {
      type: "demo_asset",
      name: "Welcome to Matteblack",
      slug: "welcome-demo-assets",
      description: "Sample images and assets to help you explore Matteblack's features. Free for all users.",
      is_free: true,
      is_published: true,
      tags: ["demo", "onboarding", "free"],
      metadata: { purpose: "onboarding" },
      contents: [
        { name: "Sample Landscape", content_type: "asset", metadata: { type: "image", category: "landscape" } },
        { name: "Sample Portrait", content_type: "asset", metadata: { type: "image", category: "portrait" } },
        { name: "Sample Product Shot", content_type: "asset", metadata: { type: "image", category: "product" } },
      ],
    },
    {
      type: "style_pack",
      name: "Halftone Retro Pack",
      slug: "halftone-retro-pack",
      description: "Vintage halftone and duotone styles for product photography. Includes 6 curated styles inspired by mid-century print design.",
      is_free: false,
      price_cents: 1999,
      is_published: true,
      tags: ["retro", "halftone", "vintage", "product"],
      metadata: { style_count: 6 },
      contents: [
        { name: "Duotone Blue", content_type: "style", metadata: { color_primary: "#1a2b3c", color_secondary: "#4d5e6f", pattern: "halftone" } },
        { name: "Duotone Red", content_type: "style", metadata: { color_primary: "#8b1a1a", color_secondary: "#d4a574", pattern: "halftone" } },
        { name: "Classic Newsprint", content_type: "style", metadata: { color_primary: "#2c2c2c", color_secondary: "#f5f0e8", pattern: "dot_screen" } },
        { name: "Pop Art Burst", content_type: "style", metadata: { color_primary: "#ff1744", color_secondary: "#ffeb3b", pattern: "benday_dots" } },
        { name: "Vintage Sepia", content_type: "style", metadata: { color_primary: "#704214", color_secondary: "#f4e4c1", pattern: "grain" } },
        { name: "Midnight Mono", content_type: "style", metadata: { color_primary: "#0d1117", color_secondary: "#c9d1d9", pattern: "crosshatch" } },
      ],
    },
    {
      type: "style_pack",
      name: "Gradient Dreams Collection",
      slug: "gradient-dreams-collection",
      description: "Modern gradient styles for creative projects. Smooth color transitions and vibrant palettes.",
      is_free: true,
      is_published: true,
      tags: ["gradient", "modern", "free", "colorful"],
      metadata: { style_count: 4 },
      contents: [
        { name: "Sunset Warm", content_type: "style", metadata: { gradient: "linear", colors: ["#ff6b35", "#f7c59f", "#efefd0"] } },
        { name: "Ocean Deep", content_type: "style", metadata: { gradient: "linear", colors: ["#0077b6", "#00b4d8", "#90e0ef"] } },
        { name: "Forest Mist", content_type: "style", metadata: { gradient: "radial", colors: ["#2d6a4f", "#52b788", "#d8f3dc"] } },
        { name: "Neon Nights", content_type: "style", metadata: { gradient: "linear", colors: ["#7400b8", "#e040fb", "#ff6d00"] } },
      ],
    },
  ];

  for (const item of items) {
    const existing = await pool.query("SELECT id FROM platform_items WHERE slug = $1", [item.slug]);
    if (existing.rows.length > 0) {
      console.log(`  Skipping "${item.name}" (already exists)`);
      continue;
    }

    const result = await pool.query(
      `INSERT INTO platform_items (type, name, slug, description, is_free, price_cents, is_published, tags, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        item.type,
        item.name,
        item.slug,
        item.description,
        item.is_free,
        (item as any).price_cents || null,
        item.is_published,
        item.tags,
        JSON.stringify(item.metadata),
      ]
    );
    const itemId = result.rows[0].id;
    console.log(`  Created "${item.name}" (${itemId})`);

    for (let i = 0; i < item.contents.length; i++) {
      const content = item.contents[i];
      await pool.query(
        `INSERT INTO platform_item_contents (platform_item_id, name, content_type, metadata, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [itemId, content.name, content.content_type, JSON.stringify(content.metadata), i]
      );
    }
    console.log(`    Added ${item.contents.length} content items`);
  }

  console.log("Seed complete!");
  await pool.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
