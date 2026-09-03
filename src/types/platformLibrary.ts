export type PlatformItemType = 'style_pack' | 'axiom_template' | 'node_workflow' | 'demo_asset' | 'skill';
export type ContentType = 'style' | 'axiom' | 'workflow' | 'asset' | 'skill';
export type EntitlementSource = 'purchase' | 'grant' | 'promo' | 'subscription';

export interface PlatformItem {
  id: string;
  type: PlatformItemType;
  name: string;
  slug: string;
  description: string | null;
  thumbnail_url: string | null;
  preview_urls: string[];
  is_free: boolean;
  price_cents: number | null;
  tags: string[];
  user_has_access: boolean;
  access_source: EntitlementSource | 'free' | null;
  content_count: number;
  sort_order: number;
  created_at: string;
}

export interface PlatformItemContent {
  id: string;
  platform_item_id: string;
  name: string;
  content_type: ContentType;
  file_url: string | null;
  file_type: string | null;
  thumbnail_url: string | null;
  metadata: Record<string, unknown>;
  sort_order: number;
}

export interface PlatformItemDetail extends PlatformItem {
  contents: PlatformItemContent[];
}

export interface UserEntitlement {
  id: string;
  user_id: string;
  platform_item_id: string;
  source: EntitlementSource;
  granted_at: string;
  expires_at: string | null;
  is_active: boolean;
  platform_item: PlatformItem;
}

export interface Folder {
  id: string;
  user_id: string;
  name: string;
  type: 'image' | 'video' | 'music' | 'voice' | 'sound_effect';
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Bucket {
  id: string;
  user_id: string | null;
  workspace_id: string | null;
  name: string;
  type: 'axiom' | 'style';
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Asset {
  id: string;
  user_id: string;
  type: 'image' | 'video';
  folder_id: string | null;
  project_id: string | null;
  source: 'canvas' | 'standalone' | 'upload' | 'platform';
  name: string;
  file_url: string;
  file_type: string | null;
  metadata: Record<string, unknown>;
  status: 'complete' | 'processing' | 'failed_upload';
  created_at: string;
  updated_at: string;
}

export interface AudioAsset {
  id: string;
  user_id: string;
  audio_class: 'music' | 'voice' | 'sound_effect';
  folder_id: string | null;
  name: string;
  file_url: string;
  file_type: string | null;
  duration_seconds: number | null;
  metadata: Record<string, unknown>;
  status: 'complete' | 'processing' | 'failed_upload';
  created_at: string;
  updated_at: string;
}
