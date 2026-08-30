import pg from "pg";
import { MODEL_PRICING_CONFIG } from "./config/modelPricing";
import { LOCAL_MODE } from "./config/runtime.js";
import { createLocalPool } from "./db-local.js";

const { Pool } = pg;

export async function getOrCreateDefaultFolder(userId: string, folderName: string): Promise<string> {
  const existing = await pool.query(
    "SELECT id FROM folders WHERE user_id = $1 AND name = $2 AND type = 'media'",
    [userId, folderName]
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }
  try {
    const result = await pool.query(
      "INSERT INTO folders (user_id, name, type) VALUES ($1, $2, 'media') RETURNING id",
      [userId, folderName]
    );
    return result.rows[0].id;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === "23505") {
      const retry = await pool.query(
        "SELECT id FROM folders WHERE user_id = $1 AND name = $2 AND type = 'media'",
        [userId, folderName]
      );
      if (retry.rows.length > 0) {
        return retry.rows[0].id;
      }
    }
    throw err;
  }
}

function createCloudPool(): pg.Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set. Did you forget to provision a database? " +
        "(Set LOCAL_MODE=true to run against an embedded local database instead.)",
    );
  }
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 40,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });
}

// In LOCAL_MODE the pool is backed by embedded PGlite (see db-local.ts); it is
// structurally compatible with the pg.Pool surface the rest of the server uses
// (query / connect / end), so we cast to keep existing call sites unchanged.
export const pool: pg.Pool = LOCAL_MODE
  ? (createLocalPool() as unknown as pg.Pool)
  : createCloudPool();

export async function initDB() {
  await pool.query(`
    -- plpgsql backs the set_updated_at() trigger below. A fresh PGlite cluster
    -- registers it automatically, but a data dir created by an older PGlite build
    -- may not have it — so ensure it before any LANGUAGE plpgsql object. Idempotent
    -- no-op on fresh clusters and on cloud Postgres (where plpgsql always exists).
    CREATE EXTENSION IF NOT EXISTS plpgsql;

    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      avatar_url TEXT DEFAULT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL DEFAULT 'My Workspace',
      owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (workspace_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS workspace_invitations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT DEFAULT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT DEFAULT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE DEFAULT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_line1 TEXT DEFAULT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_line2 TEXT DEFAULT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_city TEXT DEFAULT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_state TEXT DEFAULT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_zip TEXT DEFAULT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_country TEXT DEFAULT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_accepted_at TIMESTAMPTZ DEFAULT NULL;

    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'signup',
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_email_verification_token ON email_verification_tokens (token);

    CREATE TABLE IF NOT EXISTS jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      input JSONB NOT NULL DEFAULT '{}',
      output JSONB DEFAULT NULL,
      error TEXT DEFAULT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS model TEXT DEFAULT NULL;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '{}';
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS progress INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_url TEXT DEFAULT NULL;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS credits_charged INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
    CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs (user_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_workspace ON jobs (workspace_id);

    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_jobs_updated_at ON jobs;
    CREATE TRIGGER trg_jobs_updated_at
      BEFORE UPDATE ON jobs
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS credits (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      balance INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'personal';

    ALTER TABLE workspace_invitations ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';

    ALTER TABLE workspace_invitations ADD COLUMN IF NOT EXISTS invited_by UUID;
    ALTER TABLE workspace_invitations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

    UPDATE workspace_invitations SET invited_by = (SELECT owner_id FROM workspaces WHERE workspaces.id = workspace_invitations.workspace_id) WHERE invited_by IS NULL;
    UPDATE workspace_invitations SET expires_at = sent_at + INTERVAL '7 days' WHERE expires_at IS NULL;

    ALTER TABLE workspace_invitations ALTER COLUMN invited_by SET NOT NULL;
    ALTER TABLE workspace_invitations ALTER COLUMN expires_at SET NOT NULL;

    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
    ALTER TABLE users ALTER COLUMN password_hash SET DEFAULT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS workos_user_id TEXT DEFAULT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_workos_user_id ON users (workos_user_id) WHERE workos_user_id IS NOT NULL;

    ALTER TABLE workspace_members ALTER COLUMN role SET DEFAULT 'member';
    UPDATE workspace_members SET role = 'member' WHERE role = 'editor';

    INSERT INTO credits (user_id, balance)
    SELECT id, 100 FROM users
    WHERE id NOT IN (SELECT user_id FROM credits)
    ON CONFLICT (user_id) DO NOTHING;

    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

    CREATE TABLE IF NOT EXISTS platform_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      type TEXT NOT NULL CHECK (type IN ('style_pack', 'axiom_template', 'node_workflow', 'demo_asset')),
      name TEXT NOT NULL,
      description TEXT,
      slug TEXT UNIQUE NOT NULL,
      thumbnail_url TEXT,
      preview_urls TEXT[] DEFAULT '{}',
      metadata JSONB DEFAULT '{}',
      is_free BOOLEAN DEFAULT false,
      price_cents INTEGER,
      stripe_product_id TEXT,
      stripe_price_id TEXT,
      is_published BOOLEAN DEFAULT false,
      sort_order INTEGER DEFAULT 0,
      tags TEXT[] DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      created_by UUID REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_platform_items_type ON platform_items(type);
    CREATE INDEX IF NOT EXISTS idx_platform_items_slug ON platform_items(slug);
    CREATE INDEX IF NOT EXISTS idx_platform_items_published ON platform_items(is_published);

    CREATE TABLE IF NOT EXISTS platform_item_contents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      platform_item_id UUID NOT NULL REFERENCES platform_items(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      content_type TEXT NOT NULL CHECK (content_type IN ('style', 'axiom', 'workflow', 'asset')),
      file_url TEXT,
      file_type TEXT,
      thumbnail_url TEXT,
      metadata JSONB DEFAULT '{}',
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_platform_contents_item ON platform_item_contents(platform_item_id);
    CREATE INDEX IF NOT EXISTS idx_platform_contents_type ON platform_item_contents(content_type);

    CREATE TABLE IF NOT EXISTS user_entitlements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform_item_id UUID NOT NULL REFERENCES platform_items(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('purchase', 'grant', 'promo', 'subscription')),
      stripe_payment_intent_id TEXT,
      granted_by UUID REFERENCES users(id),
      granted_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(user_id, platform_item_id)
    );

    CREATE INDEX IF NOT EXISTS idx_entitlements_user ON user_entitlements(user_id);
    CREATE INDEX IF NOT EXISTS idx_entitlements_item ON user_entitlements(platform_item_id);
    CREATE INDEX IF NOT EXISTS idx_entitlements_active ON user_entitlements(user_id, is_active);

    CREATE TABLE IF NOT EXISTS org_entitlements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      platform_item_id UUID NOT NULL REFERENCES platform_items(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('purchase', 'grant', 'promo', 'subscription')),
      stripe_payment_intent_id TEXT,
      granted_by UUID REFERENCES users(id),
      granted_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(workspace_id, platform_item_id)
    );

    CREATE INDEX IF NOT EXISTS idx_org_entitlements_ws ON org_entitlements(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_org_entitlements_item ON org_entitlements(platform_item_id);

    CREATE TABLE IF NOT EXISTS folders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('image', 'video', 'media', 'music', 'voice', 'sound_effect')),
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(user_id, name, type)
    );

    DO $$ BEGIN
      ALTER TABLE folders DROP CONSTRAINT IF EXISTS folders_type_check;
      ALTER TABLE folders ADD CONSTRAINT folders_type_check CHECK (type IN ('image', 'video', 'media', 'music', 'voice', 'sound_effect'));
    EXCEPTION WHEN others THEN NULL;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_folders_user_type ON folders(user_id, type);

    CREATE TABLE IF NOT EXISTS buckets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('axiom', 'style')),
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      CHECK (
        (user_id IS NOT NULL AND workspace_id IS NULL)
        OR
        (user_id IS NULL AND workspace_id IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_buckets_user_type ON buckets(user_id, type);
    CREATE INDEX IF NOT EXISTS idx_buckets_ws_type ON buckets(workspace_id, type);

    CREATE TABLE IF NOT EXISTS axioms (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
      bucket_id UUID REFERENCES buckets(id) ON DELETE SET NULL DEFAULT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      images JSONB NOT NULL DEFAULT '[]',
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      CHECK (
        (user_id IS NOT NULL AND workspace_id IS NULL)
        OR
        (user_id IS NULL AND workspace_id IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_axioms_user ON axioms(user_id);
    CREATE INDEX IF NOT EXISTS idx_axioms_ws ON axioms(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_axioms_bucket ON axioms(bucket_id);

    CREATE TABLE IF NOT EXISTS styles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
      bucket_id UUID REFERENCES buckets(id) ON DELETE SET NULL DEFAULT NULL,
      name TEXT NOT NULL,
      prompt TEXT DEFAULT '',
      image_url TEXT DEFAULT NULL,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      CHECK (
        (user_id IS NOT NULL AND workspace_id IS NULL)
        OR
        (user_id IS NULL AND workspace_id IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_styles_user ON styles(user_id);
    CREATE INDEX IF NOT EXISTS idx_styles_ws ON styles(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_styles_bucket ON styles(bucket_id);

    CREATE TABLE IF NOT EXISTS assets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('image', 'video', 'vector')),
      folder_id UUID REFERENCES folders(id) ON DELETE SET NULL DEFAULT NULL,
      project_id UUID DEFAULT NULL,
      source TEXT DEFAULT 'upload' CHECK (source IN ('canvas', 'standalone', 'upload', 'platform', 'brand_iq')),
      name TEXT NOT NULL,
      file_url TEXT NOT NULL,
      file_type TEXT,
      metadata JSONB DEFAULT '{}',
      status TEXT DEFAULT 'complete' CHECK (status IN ('complete', 'processing', 'failed_upload')),
      deleted_at TIMESTAMPTZ DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    ALTER TABLE assets ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

    -- Allow 'brand_iq' as an asset source so Brand IQ-uploaded logos /
    -- graphics / documents are visible in the brand-scoped media filter
    -- (and are easy to garbage-collect via WHERE source = 'brand_iq').
    DO $$
    BEGIN
      ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_source_check;
      ALTER TABLE assets ADD CONSTRAINT assets_source_check
        CHECK (source IN ('canvas', 'standalone', 'upload', 'platform', 'brand_iq'));
    EXCEPTION WHEN others THEN NULL;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_assets_user_type ON assets(user_id, type);
    CREATE INDEX IF NOT EXISTS idx_assets_folder ON assets(folder_id);
    CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);
    CREATE INDEX IF NOT EXISTS idx_assets_source ON assets(source);
    CREATE INDEX IF NOT EXISTS idx_assets_deleted ON assets(deleted_at);

    CREATE TABLE IF NOT EXISTS audio_assets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      audio_class TEXT NOT NULL CHECK (audio_class IN ('music', 'voice', 'sound_effect')),
      folder_id UUID REFERENCES folders(id) ON DELETE SET NULL DEFAULT NULL,
      name TEXT NOT NULL,
      file_url TEXT NOT NULL,
      file_type TEXT,
      duration_seconds NUMERIC,
      metadata JSONB DEFAULT '{}',
      status TEXT DEFAULT 'complete' CHECK (status IN ('complete', 'processing', 'failed_upload')),
      deleted_at TIMESTAMPTZ DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    ALTER TABLE audio_assets ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE audio_assets ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'upload';

    DROP INDEX IF EXISTS idx_generation_tray_user;
    DROP INDEX IF EXISTS idx_generation_tray_canvas;

    CREATE INDEX IF NOT EXISTS idx_audio_assets_user_class ON audio_assets(user_id, audio_class);
    CREATE INDEX IF NOT EXISTS idx_audio_assets_folder ON audio_assets(folder_id);
    CREATE INDEX IF NOT EXISTS idx_audio_assets_deleted ON audio_assets(deleted_at);

    DROP TRIGGER IF EXISTS trg_platform_items_updated_at ON platform_items;
    CREATE TRIGGER trg_platform_items_updated_at
      BEFORE UPDATE ON platform_items
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    DROP TRIGGER IF EXISTS trg_assets_updated_at ON assets;
    CREATE TRIGGER trg_assets_updated_at
      BEFORE UPDATE ON assets
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    DROP TRIGGER IF EXISTS trg_audio_assets_updated_at ON audio_assets;
    CREATE TRIGGER trg_audio_assets_updated_at
      BEFORE UPDATE ON audio_assets
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS canvas_states (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Untitled Project',
      project_type TEXT NOT NULL DEFAULT 'design' CHECK (project_type IN ('design', 'cinema')),
      viewport_x DOUBLE PRECISION NOT NULL DEFAULT 0,
      viewport_y DOUBLE PRECISION NOT NULL DEFAULT 0,
      viewport_zoom DOUBLE PRECISION NOT NULL DEFAULT 1,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    DO $$ BEGIN
      ALTER TABLE canvas_states ADD COLUMN IF NOT EXISTS project_type TEXT NOT NULL DEFAULT 'design';
      ALTER TABLE canvas_states DROP CONSTRAINT IF EXISTS canvas_states_project_type_check;
      UPDATE canvas_states SET project_type = 'design' WHERE project_type = 'cinema';
      ALTER TABLE canvas_states ADD CONSTRAINT canvas_states_project_type_check CHECK (project_type IN ('design', 'cinema'));
    EXCEPTION WHEN others THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE canvas_states ADD COLUMN IF NOT EXISTS viewport_rebaselined BOOLEAN NOT NULL DEFAULT FALSE;
      UPDATE canvas_states SET viewport_zoom = viewport_zoom * 0.25, viewport_rebaselined = TRUE WHERE viewport_rebaselined = FALSE;
      ALTER TABLE canvas_states ALTER COLUMN viewport_rebaselined SET DEFAULT TRUE;
      ALTER TABLE canvas_states ALTER COLUMN viewport_zoom SET DEFAULT 0.25;
    EXCEPTION WHEN others THEN NULL;
    END $$;

    DROP INDEX IF EXISTS idx_canvas_states_ws_user;
    CREATE INDEX IF NOT EXISTS idx_canvas_states_ws_user_nonuniq ON canvas_states(workspace_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_canvas_states_workspace ON canvas_states(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_canvas_states_user ON canvas_states(user_id);

    DROP TRIGGER IF EXISTS trg_canvas_states_updated_at ON canvas_states;
    CREATE TRIGGER trg_canvas_states_updated_at
      BEFORE UPDATE ON canvas_states
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS audio_projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Untitled Audio Project',
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_audio_projects_user ON audio_projects(user_id);

    DROP TRIGGER IF EXISTS trg_audio_projects_updated_at ON audio_projects;
    CREATE TRIGGER trg_audio_projects_updated_at
      BEFORE UPDATE ON audio_projects
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS audio_clips (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID NOT NULL REFERENCES audio_projects(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'tts',
      prompt TEXT NOT NULL DEFAULT '',
      duration TEXT NOT NULL DEFAULT '0:00',
      voice TEXT,
      style TEXT,
      audio_url TEXT,
      job_id UUID,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE audio_clips ADD COLUMN IF NOT EXISTS saved_asset_id UUID REFERENCES audio_assets(id) ON DELETE SET NULL DEFAULT NULL;

    CREATE INDEX IF NOT EXISTS idx_audio_clips_project ON audio_clips(project_id);
    CREATE INDEX IF NOT EXISTS idx_audio_clips_user ON audio_clips(user_id);

    DROP TRIGGER IF EXISTS trg_audio_clips_updated_at ON audio_clips;
    CREATE TRIGGER trg_audio_clips_updated_at
      BEFORE UPDATE ON audio_clips
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    DROP TABLE IF EXISTS cinema_assets CASCADE;
    DROP TABLE IF EXISTS cinema_projects CASCADE;

    CREATE TABLE IF NOT EXISTS canvas_nodes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      canvas_id UUID NOT NULL REFERENCES canvas_states(id) ON DELETE CASCADE,
      asset_id UUID REFERENCES assets(id) ON DELETE SET NULL,
      job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
      node_type TEXT NOT NULL DEFAULT 'image' CHECK (node_type IN ('image', 'video', 'svg', 'generation', 'generating', 'placeholder', 'group', 'frame', 'shape', 'text', 'audio', 'cinema')),
      x DOUBLE PRECISION NOT NULL DEFAULT 0,
      y DOUBLE PRECISION NOT NULL DEFAULT 0,
      width DOUBLE PRECISION NOT NULL DEFAULT 256,
      height DOUBLE PRECISION NOT NULL DEFAULT 256,
      rotation DOUBLE PRECISION NOT NULL DEFAULT 0,
      z_index INTEGER NOT NULL DEFAULT 0,
      locked BOOLEAN NOT NULL DEFAULT false,
      visible BOOLEAN NOT NULL DEFAULT true,
      label TEXT DEFAULT '',
      src TEXT DEFAULT '',
      gradient TEXT DEFAULT '',
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    DO $$ BEGIN
      ALTER TABLE canvas_nodes DROP CONSTRAINT IF EXISTS canvas_nodes_node_type_check;
      ALTER TABLE canvas_nodes ADD CONSTRAINT canvas_nodes_node_type_check CHECK (node_type IN ('image', 'video', 'svg', 'generation', 'generating', 'placeholder', 'group', 'frame', 'shape', 'text', 'audio', 'cinema'));
    EXCEPTION WHEN others THEN NULL;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_canvas_nodes_canvas ON canvas_nodes(canvas_id);
    CREATE INDEX IF NOT EXISTS idx_canvas_nodes_asset ON canvas_nodes(asset_id);
    CREATE INDEX IF NOT EXISTS idx_canvas_nodes_job ON canvas_nodes(job_id);

    DROP TRIGGER IF EXISTS trg_canvas_nodes_updated_at ON canvas_nodes;
    CREATE TRIGGER trg_canvas_nodes_updated_at
      BEFORE UPDATE ON canvas_nodes
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS cinema_tracks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      canvas_id UUID NOT NULL REFERENCES canvas_states(id) ON DELETE CASCADE,
      -- Which cinema node owns this track. '' means "the canvas's one cinema
      -- frame", the pre-multi-node shape; the loader adopts those rows into the
      -- first cinema node it finds so old canvases keep their timelines.
      node_id TEXT NOT NULL DEFAULT '',
      track_type TEXT NOT NULL CHECK (track_type IN ('video', 'audio')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE cinema_tracks ADD COLUMN IF NOT EXISTS node_id TEXT NOT NULL DEFAULT '';
    -- Silences every clip on the track without touching their own volumes, so
    -- unmuting restores the mix. The case it exists for: mute the video track
    -- so a music bed plays under the picture instead of fighting the audio
    -- baked into generated clips.
    ALTER TABLE cinema_tracks ADD COLUMN IF NOT EXISTS muted BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE INDEX IF NOT EXISTS idx_cinema_tracks_canvas ON cinema_tracks(canvas_id);
    CREATE INDEX IF NOT EXISTS idx_cinema_tracks_node ON cinema_tracks(canvas_id, node_id);

    DROP TRIGGER IF EXISTS trg_cinema_tracks_updated_at ON cinema_tracks;
    CREATE TRIGGER trg_cinema_tracks_updated_at
      BEFORE UPDATE ON cinema_tracks
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS cinema_clips (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      track_id UUID NOT NULL REFERENCES cinema_tracks(id) ON DELETE CASCADE,
      canvas_id UUID NOT NULL REFERENCES canvas_states(id) ON DELETE CASCADE,
      source_node_id TEXT NOT NULL DEFAULT '',
      src TEXT NOT NULL DEFAULT '',
      clip_type TEXT NOT NULL CHECK (clip_type IN ('video', 'image', 'audio')),
      duration DOUBLE PRECISION NOT NULL DEFAULT 3,
      start_offset DOUBLE PRECISION NOT NULL DEFAULT 0,
      trim_start DOUBLE PRECISION NOT NULL DEFAULT 0,
      trim_end DOUBLE PRECISION NOT NULL DEFAULT 0,
      volume DOUBLE PRECISION NOT NULL DEFAULT 1,
      label TEXT DEFAULT '',
      linked_clip_id UUID DEFAULT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_cinema_clips_track ON cinema_clips(track_id);
    CREATE INDEX IF NOT EXISTS idx_cinema_clips_canvas ON cinema_clips(canvas_id);

    DROP TRIGGER IF EXISTS trg_cinema_clips_updated_at ON cinema_clips;
    CREATE TRIGGER trg_cinema_clips_updated_at
      BEFORE UPDATE ON cinema_clips
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS cinema_clip_tombstones (
      canvas_id UUID NOT NULL REFERENCES canvas_states(id) ON DELETE CASCADE,
      clip_id UUID NOT NULL,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (canvas_id, clip_id)
    );

    CREATE INDEX IF NOT EXISTS idx_cinema_clip_tombstones_canvas ON cinema_clip_tombstones(canvas_id);

    CREATE TABLE IF NOT EXISTS project_share_settings (
      project_id UUID PRIMARY KEY REFERENCES canvas_states(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      share_token TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_project_share_settings_token ON project_share_settings(share_token);

    DROP TRIGGER IF EXISTS trg_project_share_settings_updated_at ON project_share_settings;
    CREATE TRIGGER trg_project_share_settings_updated_at
      BEFORE UPDATE ON project_share_settings
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS project_participants (
      project_id UUID NOT NULL REFERENCES canvas_states(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer')),
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_participants_user ON project_participants(user_id);
    CREATE INDEX IF NOT EXISTS idx_project_participants_project ON project_participants(project_id);

    DROP TABLE IF EXISTS generation_tray CASCADE;

    CREATE TABLE IF NOT EXISTS clearcheck_audits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source TEXT NOT NULL DEFAULT 'upload',
      file_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'clear' CHECK (status IN ('clear', 'flagged')),
      labels JSONB NOT NULL DEFAULT '[]',
      moderation_flags JSONB NOT NULL DEFAULT '[]',
      image_file_url TEXT DEFAULT NULL,
      report_file_url TEXT DEFAULT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_clearcheck_audits_user ON clearcheck_audits(user_id);
    CREATE INDEX IF NOT EXISTS idx_clearcheck_audits_created ON clearcheck_audits(created_at);

    CREATE TABLE IF NOT EXISTS notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'error', 'success')),
      metadata JSONB DEFAULT '{}',
      read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read);
    CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);

    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS error_type TEXT DEFAULT NULL;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS error_detail JSONB DEFAULT NULL;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS fal_request_id TEXT DEFAULT NULL;
    CREATE INDEX IF NOT EXISTS idx_jobs_fal_request_id ON jobs (fal_request_id) WHERE fal_request_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS credit_config (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      generation_type TEXT UNIQUE NOT NULL,
      credit_cost INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_credit_config_type ON credit_config(generation_type);

    CREATE TABLE IF NOT EXISTS credit_ledger (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      org_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reason TEXT NOT NULL,
      reference_id UUID DEFAULT NULL,
      metadata JSONB DEFAULT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT NULL;
    ALTER TABLE credit_ledger ALTER COLUMN reference_id TYPE TEXT USING reference_id::TEXT;

    CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger(user_id);
    CREATE INDEX IF NOT EXISTS idx_credit_ledger_created ON credit_ledger(created_at);
    CREATE INDEX IF NOT EXISTS idx_credit_ledger_reason ON credit_ledger(reason);
    CREATE INDEX IF NOT EXISTS idx_credit_ledger_reference ON credit_ledger(reference_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_reason_ref ON credit_ledger(reason, reference_id) WHERE reference_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS model_pricing (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      model_key TEXT UNIQUE NOT NULL,
      base_cost INTEGER NOT NULL DEFAULT 10,
      resolution_multipliers JSONB DEFAULT NULL,
      duration_multipliers JSONB DEFAULT NULL,
      feature_surcharges JSONB DEFAULT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_model_pricing_key ON model_pricing(model_key);

    ALTER TABLE model_pricing ADD COLUMN IF NOT EXISTS input_token_net_cost_per_million NUMERIC(12,4) NOT NULL DEFAULT 0;
    ALTER TABLE model_pricing ADD COLUMN IF NOT EXISTS output_token_net_cost_per_million NUMERIC(12,4) NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS rate_limits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      generation_type TEXT UNIQUE NOT NULL,
      max_requests INTEGER NOT NULL DEFAULT 10,
      window_seconds INTEGER NOT NULL DEFAULT 60,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_rate_limits_type ON rate_limits(generation_type);

    CREATE TABLE IF NOT EXISTS credit_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS low_balance_alerts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      threshold INTEGER NOT NULL,
      alerted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, threshold)
    );

    CREATE INDEX IF NOT EXISTS idx_low_balance_alerts_user ON low_balance_alerts(user_id);

    ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT DEFAULT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer_id ON users (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stripe_subscription_id TEXT UNIQUE NOT NULL,
      stripe_customer_id TEXT NOT NULL,
      plan_tier TEXT NOT NULL CHECK (plan_tier IN ('starter', 'pro', 'power')),
      status TEXT NOT NULL DEFAULT 'incomplete' CHECK (status IN ('active', 'past_due', 'canceled', 'incomplete')),
      current_period_start TIMESTAMPTZ,
      current_period_end TIMESTAMPTZ,
      credits_per_period INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub ON subscriptions(stripe_subscription_id);

    CREATE TABLE IF NOT EXISTS purchases (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stripe_session_id TEXT UNIQUE,
      stripe_payment_intent_id TEXT UNIQUE,
      amount_cents INTEGER NOT NULL,
      credits_granted INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);
    CREATE INDEX IF NOT EXISTS idx_purchases_session ON purchases(stripe_session_id);
    CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);

    CREATE TABLE IF NOT EXISTS workspace_credits (
      workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      balance INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_subscriptions_workspace ON subscriptions(workspace_id) WHERE workspace_id IS NOT NULL;

    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_purchases_workspace ON purchases(workspace_id) WHERE workspace_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_credit_ledger_org ON credit_ledger(org_id) WHERE org_id IS NOT NULL;

    ALTER TABLE low_balance_alerts ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE low_balance_alerts ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_low_balance_alerts_workspace ON low_balance_alerts(workspace_id, threshold) WHERE workspace_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS pending_refunds (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      reference_id TEXT,
      org_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_pending_refunds_user ON pending_refunds(user_id);
    CREATE INDEX IF NOT EXISTS idx_pending_refunds_created ON pending_refunds(created_at);

    CREATE TABLE IF NOT EXISTS seedance_verified_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      full_legal_name TEXT NOT NULL,
      business_name TEXT NOT NULL,
      business_email TEXT NOT NULL,
      country_code TEXT NOT NULL,
      verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_seedance_verified_users_user ON seedance_verified_users(user_id);

    CREATE TABLE IF NOT EXISTS agent_chats (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT 'New chat',
      model_key TEXT NOT NULL DEFAULT 'haiku',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_agent_chats_user ON agent_chats(user_id);
    CREATE INDEX IF NOT EXISTS idx_agent_chats_user_updated ON agent_chats(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_chats_workspace ON agent_chats(workspace_id) WHERE workspace_id IS NOT NULL;

    DROP TRIGGER IF EXISTS trg_agent_chats_updated_at ON agent_chats;
    CREATE TRIGGER trg_agent_chats_updated_at
      BEFORE UPDATE ON agent_chats
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS agent_chat_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      chat_id UUID NOT NULL REFERENCES agent_chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'error')),
      text TEXT NOT NULL DEFAULT '',
      images JSONB NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_agent_chat_messages_chat ON agent_chat_messages(chat_id, sort_order);

    CREATE TABLE IF NOT EXISTS brand_iq_profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Untitled brand',
      slug TEXT NOT NULL DEFAULT '',
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      archived_at TIMESTAMPTZ DEFAULT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      avatar_color TEXT NOT NULL DEFAULT '#6366f1',
      data JSONB NOT NULL DEFAULT '{}',
      design_md TEXT NOT NULL DEFAULT '',
      design_md_url TEXT DEFAULT NULL,
      crawl_evidence JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_brand_iq_profiles_ws ON brand_iq_profiles(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_brand_iq_profiles_ws_archived ON brand_iq_profiles(workspace_id, archived_at);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_brand_iq_profiles_default_per_ws
      ON brand_iq_profiles(workspace_id) WHERE is_default = TRUE AND archived_at IS NULL;

    DROP TRIGGER IF EXISTS trg_brand_iq_profiles_updated_at ON brand_iq_profiles;
    CREATE TRIGGER trg_brand_iq_profiles_updated_at
      BEFORE UPDATE ON brand_iq_profiles
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS project_brand_overrides (
      project_id UUID PRIMARY KEY REFERENCES canvas_states(id) ON DELETE CASCADE,
      brand_profile_id UUID NOT NULL REFERENCES brand_iq_profiles(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_project_brand_overrides_brand ON project_brand_overrides(brand_profile_id);

    CREATE TABLE IF NOT EXISTS brand_iq_assets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      profile_id UUID NOT NULL REFERENCES brand_iq_profiles(id) ON DELETE CASCADE,
      asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('logo_light', 'logo_dark', 'graphic', 'inspiration', 'document')),
      extracted_text TEXT DEFAULT NULL,
      source_mime TEXT DEFAULT NULL,
      doc_role TEXT DEFAULT NULL,
      extraction_status TEXT DEFAULT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_brand_iq_assets_profile ON brand_iq_assets(profile_id);
    CREATE INDEX IF NOT EXISTS idx_brand_iq_assets_role ON brand_iq_assets(profile_id, role);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_brand_iq_assets_logo_light
      ON brand_iq_assets(profile_id) WHERE role = 'logo_light';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_brand_iq_assets_logo_dark
      ON brand_iq_assets(profile_id) WHERE role = 'logo_dark';

    ALTER TABLE agent_chats ADD COLUMN IF NOT EXISTS brand_profile_id UUID REFERENCES brand_iq_profiles(id) ON DELETE SET NULL;
    ALTER TABLE agent_chats ADD COLUMN IF NOT EXISTS brand_disabled BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS idx_agent_chats_brand ON agent_chats(brand_profile_id) WHERE brand_profile_id IS NOT NULL;

    -- Sticky "@product" mentions per chat. Stores opaque ids of the form
    -- "axiom:<uuid>" or "platform:<uuid>" so a single column can carry both
    -- user/workspace axioms and platform-content products without an extra
    -- discriminator column. Validated against access on every read.
    ALTER TABLE agent_chats ADD COLUMN IF NOT EXISTS last_product_ids TEXT[] NOT NULL DEFAULT '{}';
  `);

  const backfillClient = await pool.connect();
  try {
    await backfillClient.query('BEGIN');
    await backfillClient.query(`
      INSERT INTO workspaces (name, owner_id, type)
      SELECT u.display_name || '''s Workspace', u.id, 'personal'
      FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM workspaces w2 WHERE w2.owner_id = u.id AND w2.type = 'personal'
      );
    `);
    await backfillClient.query(`
      INSERT INTO workspace_members (workspace_id, user_id, role)
      SELECT w.id, w.owner_id, 'owner'
      FROM workspaces w
      WHERE w.type = 'personal'
        AND NOT EXISTS (
          SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = w.owner_id
        );
    `);
    const upgradedAdmins = await backfillClient.query(`
      UPDATE workspace_members wm
      SET role = 'admin'
      FROM (
        SELECT DISTINCT ON (wi.workspace_id, u.id) wi.workspace_id, u.id AS user_id, wi.role
        FROM workspace_invitations wi
        JOIN users u ON LOWER(TRIM(u.email)) = LOWER(TRIM(wi.email))
        WHERE wi.status = 'accepted'
        ORDER BY wi.workspace_id, u.id, wi.sent_at DESC
      ) latest
      WHERE wm.workspace_id = latest.workspace_id
        AND wm.user_id = latest.user_id
        AND latest.role = 'admin'
        AND wm.role = 'member'
      RETURNING wm.workspace_id, wm.user_id;
    `);
    if (upgradedAdmins.rowCount && upgradedAdmins.rowCount > 0) {
      console.log(`[backfill] Upgraded ${upgradedAdmins.rowCount} stale member -> admin role(s) from accepted invitations`);
    }
    await backfillClient.query('COMMIT');
  } catch (err) {
    await backfillClient.query('ROLLBACK');
    throw err;
  } finally {
    backfillClient.release();
  }

  try {
    const defaultRateLimits: Record<string, { max: number; window: number }> = {
      text_to_image: { max: 10, window: 60 },
      image_to_image: { max: 10, window: 60 },
      upscale: { max: 10, window: 60 },
      resize: { max: 15, window: 60 },
      remove_bg: { max: 15, window: 60 },
      audio_tts: { max: 10, window: 60 },
      audio_music: { max: 5, window: 60 },
      audio_sfx: { max: 10, window: 60 },
      audio_voice_changer: { max: 5, window: 60 },
      video_gen: { max: 5, window: 60 },
      avatar: { max: 5, window: 60 },
      text_to_vector: { max: 10, window: 60 },
      image_to_vector: { max: 10, window: 60 },
      clearcheck: { max: 15, window: 60 },
      gif_maker: { max: 20, window: 60 },
    };
    for (const [genType, limits] of Object.entries(defaultRateLimits)) {
      await pool.query(
        `INSERT INTO rate_limits (generation_type, max_requests, window_seconds)
         VALUES ($1, $2, $3)
         ON CONFLICT (generation_type) DO NOTHING`,
        [genType, limits.max, limits.window]
      );
    }

    await pool.query(
      `INSERT INTO credit_settings (key, value)
       VALUES ('low_balance_thresholds', '[50, 20, 10]')
       ON CONFLICT (key) DO NOTHING`
    );

    for (const mp of MODEL_PRICING_CONFIG) {
      // Token rates only get seeded when the row is first created; once a
      // model is in the table, admins own the value and we don't clobber
      // their edits. base_cost / multipliers continue to behave the same
      // way they always have (overwritten from config on every boot) so
      // existing operational tooling is unaffected.
      await pool.query(
        `INSERT INTO model_pricing (
           model_key, base_cost, resolution_multipliers, duration_multipliers, feature_surcharges,
           input_token_net_cost_per_million, output_token_net_cost_per_million
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (model_key) DO UPDATE SET
           base_cost = EXCLUDED.base_cost,
           resolution_multipliers = EXCLUDED.resolution_multipliers,
           duration_multipliers = EXCLUDED.duration_multipliers,
           feature_surcharges = EXCLUDED.feature_surcharges`,
        [
          mp.model_key,
          mp.base_cost,
          mp.resolution_multipliers ? JSON.stringify(mp.resolution_multipliers) : null,
          mp.duration_multipliers ? JSON.stringify(mp.duration_multipliers) : null,
          mp.feature_surcharges ? JSON.stringify(mp.feature_surcharges) : null,
          mp.input_token_net_cost_per_million ?? 0,
          mp.output_token_net_cost_per_million ?? 0,
        ]
      );
    }

    // Backfill: for rows that already exist in production with the default
    // 0/0 token rates, seed them from config the first time we see the
    // config carry non-zero values. This is what makes Sonnet start
    // billing correctly the moment the migration runs without requiring
    // an admin to type rates by hand. Subsequent edits in the admin UI
    // are preserved because we only update when the stored value is 0.
    for (const mp of MODEL_PRICING_CONFIG) {
      const seedIn = mp.input_token_net_cost_per_million ?? 0;
      const seedOut = mp.output_token_net_cost_per_million ?? 0;
      if (seedIn === 0 && seedOut === 0) continue;
      await pool.query(
        `UPDATE model_pricing
           SET input_token_net_cost_per_million = $2,
               output_token_net_cost_per_million = $3
         WHERE model_key = $1
           AND input_token_net_cost_per_million = 0
           AND output_token_net_cost_per_million = 0`,
        [mp.model_key, seedIn, seedOut]
      );
    }

    console.log("Seeded rate_limits, credit_settings, and model_pricing from config");
  } catch (err) {
    console.error("Credit config seed error:", err);
  }

  try {
    const colCheck = await pool.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'audio_projects' AND column_name = 'workspace_id'
    `);
    if (colCheck.rows.length === 0) {
      await pool.query(`ALTER TABLE audio_projects ADD COLUMN workspace_id UUID`);
      console.log('Added workspace_id column to audio_projects');
    }

    const nullCount = await pool.query(`SELECT COUNT(*) FROM audio_projects WHERE workspace_id IS NULL`);
    if (parseInt(nullCount.rows[0].count) > 0) {
      const backfilled = await pool.query(`
        UPDATE audio_projects ap
        SET workspace_id = (
          SELECT w.id FROM workspaces w WHERE w.owner_id = ap.user_id AND w.type = 'personal' LIMIT 1
        )
        WHERE ap.workspace_id IS NULL
      `);
      console.log(`Backfilled workspace_id for ${backfilled.rowCount} audio projects`);

      const orphaned = await pool.query(`SELECT COUNT(*) FROM audio_projects WHERE workspace_id IS NULL`);
      const orphanCount = parseInt(orphaned.rows[0].count);
      if (orphanCount > 0) {
        console.error(`WARNING: ${orphanCount} audio_projects could not be backfilled (users without personal workspace). These rows will not be accessible until workspace_id is set.`);
      }
    }

    const nullRemaining = await pool.query(`SELECT COUNT(*) FROM audio_projects WHERE workspace_id IS NULL`);
    if (parseInt(nullRemaining.rows[0].count) === 0) {
      const notNullCheck = await pool.query(`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'audio_projects' AND column_name = 'workspace_id'
      `);
      if (notNullCheck.rows[0]?.is_nullable === 'YES') {
        await pool.query(`ALTER TABLE audio_projects ALTER COLUMN workspace_id SET NOT NULL`);
        console.log('Set workspace_id NOT NULL on audio_projects');
      }

      const fkCheck = await pool.query(`
        SELECT 1 FROM information_schema.key_column_usage kcu
        JOIN information_schema.table_constraints tc
          ON tc.constraint_name = kcu.constraint_name AND tc.table_name = kcu.table_name
        WHERE kcu.table_name = 'audio_projects'
          AND kcu.column_name = 'workspace_id'
          AND tc.constraint_type = 'FOREIGN KEY'
      `);
      if (fkCheck.rows.length === 0) {
        await pool.query(`
          ALTER TABLE audio_projects
          ADD CONSTRAINT fk_audio_projects_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        `);
        console.log('Added FK constraint fk_audio_projects_workspace');
      }
    }

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audio_projects_ws_user ON audio_projects(workspace_id, user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audio_projects_workspace ON audio_projects(workspace_id)`);
  } catch (err) {
    console.error('Audio projects workspace_id migration error:', err);
  }

  try {
    await pool.query(`
      UPDATE canvas_states SET name = 'Untitled Project' WHERE name = 'Default Canvas';
    `);
    console.log('Migrated "Default Canvas" rows to "Untitled Project"');
  } catch (err) {
    console.error('Default canvas migration error:', err);
  }

  try {
    await pool.query(`
      INSERT INTO canvas_states (workspace_id, user_id, name)
      SELECT wm.workspace_id, wm.user_id, 'Untitled Project'
      FROM workspace_members wm
      WHERE NOT EXISTS (
        SELECT 1 FROM canvas_states cs
        WHERE cs.workspace_id = wm.workspace_id AND cs.user_id = wm.user_id
      );
    `);
    console.log('Backfilled Untitled Project for workspaces with zero canvas_states');
  } catch (err) {
    console.error('Canvas backfill error:', err);
  }

  try {
    await pool.query(`
      ALTER TABLE workspace_invitations DROP CONSTRAINT IF EXISTS workspace_invitations_status_check;
      ALTER TABLE workspace_invitations ADD CONSTRAINT workspace_invitations_status_check
        CHECK (status IN ('pending', 'accepted', 'revoked', 'superseded'));
    `);
  } catch { /* constraint already correct */ }

  try {
    await pool.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_assets_workspace ON assets(workspace_id) WHERE workspace_id IS NOT NULL`);
  } catch (err) {
    console.error('[db] assets workspace_id migration error:', err);
  }

  try {
    await pool.query(`
      ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
      ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
        CHECK (status IN ('pending', 'queued', 'processing', 'complete', 'failed', 'cancelled'));
    `);
  } catch { /* constraint already correct */ }

  try {
    await pool.query(`
      ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_type_check;
      ALTER TABLE assets ADD CONSTRAINT assets_type_check
        CHECK (type IN ('image', 'video', 'vector', 'audio'));
    `);
  } catch { /* constraint already correct */ }

  try {
    await pool.query(`
      ALTER TABLE folders DROP CONSTRAINT IF EXISTS folders_type_check;
      ALTER TABLE folders ADD CONSTRAINT folders_type_check
        CHECK (type IN ('image', 'video', 'media', 'music', 'voice', 'sound_effect'));
    `);
  } catch { /* constraint already correct */ }

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        DO $$
        DECLARE
          dup RECORD;
        BEGIN
          FOR dup IN
            SELECT f1.id AS keep_id, f2.id AS merge_id
            FROM folders f1
            JOIN folders f2 ON f1.user_id = f2.user_id AND f1.name = f2.name
            WHERE f1.type = 'image' AND f2.type = 'video'
          LOOP
            UPDATE assets SET folder_id = dup.keep_id WHERE folder_id = dup.merge_id;
            DELETE FROM folders WHERE id = dup.merge_id;
          END LOOP;

          UPDATE folders SET type = 'media' WHERE type IN ('image', 'video');
        END $$;
      `);
      await client.query('COMMIT');
      console.log('Migrated image/video folders to unified media type');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Folder migration error:', err);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Folder migration connection error:', err);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workos_user_id TEXT,
      cookie_hash TEXT,
      last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_valid BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_valid ON sessions(is_valid) WHERE is_valid = true;
    CREATE INDEX IF NOT EXISTS idx_sessions_cookie_hash ON sessions(cookie_hash) WHERE cookie_hash IS NOT NULL;

    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cookie_hash TEXT;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    DROP TRIGGER IF EXISTS trg_sessions_updated_at ON sessions;
    CREATE TRIGGER trg_sessions_updated_at
      BEFORE UPDATE ON sessions
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
  `);

  try {
    const backfillReason = "backfill:starter_to_pro_upgrade_correction";
    const alreadyGranted = await pool.query(
      `SELECT 1 FROM credit_ledger cl JOIN users u ON u.id = cl.user_id WHERE u.email = $1 AND cl.reason = $2 LIMIT 1`,
      ["ideatorx@gmail.com", backfillReason]
    );
    if (alreadyGranted.rows.length === 0) {
      const userResult = await pool.query(`SELECT id FROM users WHERE email = $1`, ["ideatorx@gmail.com"]);
      if (userResult.rows.length > 0) {
        const targetUserId = userResult.rows[0].id;
        const correctionAmount = 3000;
        const correctionClient = await pool.connect();
        try {
          await correctionClient.query("BEGIN");
          const updated = await correctionClient.query(
            `INSERT INTO credits (user_id, balance) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET balance = credits.balance + $2, updated_at = NOW()
             RETURNING balance`,
            [targetUserId, correctionAmount]
          );
          const newBalance = updated.rows[0].balance;
          await correctionClient.query(
            `INSERT INTO credit_ledger (user_id, amount, balance_after, reason)
             VALUES ($1, $2, $3, $4)`,
            [targetUserId, correctionAmount, newBalance, backfillReason]
          );
          await correctionClient.query("COMMIT");
          console.log(`[db] Granted ${correctionAmount} credit correction to ideatorx@gmail.com (new balance: ${newBalance})`);
        } catch (err) {
          await correctionClient.query("ROLLBACK");
          console.error("[db] Failed to grant credit correction to ideatorx@gmail.com:", err);
        } finally {
          correctionClient.release();
        }
      }
    }
  } catch (err) {
    console.error("[db] Credit correction check error:", err);
  }

  try {
    const migrationKey = "cinema_timeline_migration_v1";
    const migrationRan = await pool.query(
      `SELECT 1 FROM credit_ledger WHERE reason = $1 LIMIT 1`,
      [migrationKey]
    );
    if (migrationRan.rows.length === 0) {
      const migClient = await pool.connect();
      try {
        await migClient.query("BEGIN");
        const cinemaNodes = await migClient.query(
          `SELECT id, canvas_id, metadata FROM canvas_nodes WHERE node_type = 'cinema' AND metadata->'timelineState' IS NOT NULL`
        );
        let totalTracks = 0;
        let totalClips = 0;
        for (const node of cinemaNodes.rows) {
          const ts = node.metadata?.timelineState;
          if (!ts || !Array.isArray(ts.tracks)) continue;
          const canvasId = node.canvas_id;
          const existingTracks = await migClient.query(
            `SELECT id FROM cinema_tracks WHERE canvas_id = $1`,
            [canvasId]
          );
          if (existingTracks.rows.length > 0) continue;
          const oldIdToNewId = new Map<string, string>();
          for (let ti = 0; ti < ts.tracks.length; ti++) {
            const track = ts.tracks[ti];
            if (!track || !track.type) continue;
            const trackResult = await migClient.query(
              `INSERT INTO cinema_tracks (canvas_id, node_id, track_type, sort_order) VALUES ($1, $2, $3, $4) RETURNING id`,
              [canvasId, node.id, track.type, ti]
            );
            const trackId = trackResult.rows[0].id;
            totalTracks++;
            if (Array.isArray(track.clips)) {
              for (let ci = 0; ci < track.clips.length; ci++) {
                const clip = track.clips[ci];
                if (!clip || !clip.src) continue;
                const clipType = clip.type === 'video' ? 'video' : clip.type === 'audio' ? 'audio' : 'image';
                const clipResult = await migClient.query(
                  `INSERT INTO cinema_clips (track_id, canvas_id, source_node_id, src, clip_type, duration, start_offset, trim_start, trim_end, volume, label, sort_order)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
                  [
                    trackId, canvasId,
                    clip.sourceNodeId || '',
                    clip.src,
                    clipType,
                    typeof clip.duration === 'number' ? clip.duration : 3,
                    typeof clip.startOffset === 'number' ? clip.startOffset : 0,
                    typeof clip.trimStart === 'number' ? clip.trimStart : 0,
                    typeof clip.trimEnd === 'number' ? clip.trimEnd : 0,
                    typeof clip.volume === 'number' ? clip.volume : 1,
                    clip.label || '',
                    ci
                  ]
                );
                if (clip.id) {
                  oldIdToNewId.set(clip.id, clipResult.rows[0].id);
                }
                totalClips++;
              }
            }
          }
          for (const [oldId, newId] of oldIdToNewId) {
            const allClips = ts.tracks.flatMap((t: { clips?: unknown[] }) => t.clips || []);
            const oldClip = allClips.find((c: { id?: string }) => c.id === oldId);
            if (oldClip?.linkedClipId && oldIdToNewId.has(oldClip.linkedClipId)) {
              const linkedNewId = oldIdToNewId.get(oldClip.linkedClipId);
              await migClient.query(
                `UPDATE cinema_clips SET linked_clip_id = $1 WHERE id = $2`,
                [linkedNewId, newId]
              );
            }
          }
        }
        await migClient.query("COMMIT");
        console.log(`[db] cinema_timeline_migration_v1: migrated ${totalTracks} tracks and ${totalClips} clips from ${cinemaNodes.rows.length} cinema nodes`);
        try {
          await pool.query(
            `INSERT INTO credit_ledger (user_id, amount, balance_after, reason)
             SELECT id, 0, 0, $1 FROM users ORDER BY created_at ASC LIMIT 1`,
            [migrationKey]
          );
        } catch (markerErr) {
          console.error("[db] cinema_timeline_migration_v1: failed to write run-once marker — migration may re-run (idempotent):", markerErr);
        }
      } catch (migErr) {
        await migClient.query("ROLLBACK");
        console.error("[db] cinema_timeline_migration_v1: transaction rolled back:", migErr);
      } finally {
        migClient.release();
      }
    }
  } catch (err) {
    console.error("[db] cinema timeline migration error:", err);
  }

  try {
    const recoveryMarkerKey = "canvas_src_recovery_v1";
    const alreadyRan = await pool.query(
      `SELECT 1 FROM credit_ledger WHERE reason = $1 LIMIT 1`,
      [recoveryMarkerKey]
    );
    if (alreadyRan.rows.length === 0) {
      const assetRecovery = await pool.query(`
        UPDATE canvas_nodes cn
        SET src = a.file_url, updated_at = NOW()
        FROM assets a
        WHERE cn.asset_id = a.id
          AND (cn.src IS NULL OR cn.src = '')
          AND a.file_url IS NOT NULL
          AND a.file_url != ''
      `);
      const jobRecovery = await pool.query(`
        UPDATE canvas_nodes cn
        SET src = j.result_url, updated_at = NOW()
        FROM jobs j
        WHERE cn.job_id = j.id
          AND (cn.src IS NULL OR cn.src = '')
          AND j.result_url IS NOT NULL
          AND j.result_url != ''
      `);
      const totalRecovered = (assetRecovery.rowCount ?? 0) + (jobRecovery.rowCount ?? 0);
      console.log(`[db] canvas_src_recovery_v1: restored src for ${totalRecovered} node(s) (${assetRecovery.rowCount ?? 0} from assets, ${jobRecovery.rowCount ?? 0} from jobs)`);
      try {
        await pool.query(
          `INSERT INTO credit_ledger (user_id, amount, balance_after, reason)
           SELECT id, 0, 0, $1 FROM users ORDER BY created_at ASC LIMIT 1`,
          [recoveryMarkerKey]
        );
        console.log(`[db] canvas_src_recovery_v1: marker written to credit_ledger`);
      } catch (markerErr) {
        console.error(`[db] canvas_src_recovery_v1: failed to write run-once marker — recovery may re-run on next startup:`, markerErr);
      }
    }
  } catch (err) {
    console.error("[db] canvas_src_recovery error:", err);
  }
}
