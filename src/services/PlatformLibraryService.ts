import type {
  PlatformItem,
  PlatformItemDetail,
  UserEntitlement,
  PlatformItemType,
} from "../types/platformLibrary";

const API_BASE = "/api";

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(body.error?.message || `Request failed: ${res.status}`);
  }
  return res.json();
}

export class PlatformLibraryService {
  static async getItems(params?: {
    type?: PlatformItemType;
    tag?: string;
    search?: string;
  }): Promise<PlatformItem[]> {
    const searchParams = new URLSearchParams();
    if (params?.type) searchParams.set("type", params.type);
    if (params?.tag) searchParams.set("tag", params.tag);
    if (params?.search) searchParams.set("search", params.search);

    const qs = searchParams.toString();
    const res = await fetch(`${API_BASE}/platform-library${qs ? `?${qs}` : ""}`, {
      credentials: "include",
    });
    const data = await handleResponse<{ items: PlatformItem[] }>(res);
    return data.items;
  }

  static async getItem(slug: string): Promise<PlatformItemDetail> {
    const res = await fetch(`${API_BASE}/platform-library/${slug}`, {
      credentials: "include",
    });
    const data = await handleResponse<{ item: PlatformItemDetail }>(res);
    return data.item;
  }

  static async getMyEntitlements(): Promise<UserEntitlement[]> {
    const res = await fetch(`${API_BASE}/platform-library/entitlements/mine`, {
      credentials: "include",
    });
    const data = await handleResponse<{ entitlements: UserEntitlement[] }>(res);
    return data.entitlements;
  }

  static async hasAccess(itemId: string): Promise<boolean> {
    const entitlements = await this.getMyEntitlements();
    return entitlements.some((e) => e.platform_item_id === itemId && e.is_active);
  }

  static async purchase(
    itemId: string,
    scope: "user" | "org",
    workspaceId?: string
  ): Promise<{ checkout_url: string }> {
    const res = await fetch(`${API_BASE}/platform-library/purchase`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        platform_item_id: itemId,
        scope,
        workspace_id: workspaceId,
      }),
    });
    return handleResponse<{ checkout_url: string }>(res);
  }

  static async saveToSpace(
    contentId: string,
    destination: "personal" | "org",
    workspaceId?: string
  ): Promise<{ id: string }> {
    const res = await fetch(`${API_BASE}/platform-library/save-to-space`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        platform_item_content_id: contentId,
        destination,
        workspace_id: workspaceId,
      }),
    });
    return handleResponse<{ id: string }>(res);
  }
}
