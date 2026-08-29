import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import { PlatformLibraryService } from "../services/PlatformLibraryService";
import type {
  PlatformItem,
  PlatformItemDetail,
  UserEntitlement,
  PlatformItemType,
} from "../types/platformLibrary";

interface PlatformLibraryState {
  items: PlatformItem[];
  entitlements: UserEntitlement[];
  loading: boolean;
  error: string | null;
  fetchItems: (type?: PlatformItemType) => Promise<void>;
  fetchItem: (slug: string) => Promise<PlatformItemDetail | null>;
  fetchEntitlements: () => Promise<void>;
  hasAccess: (itemId: string) => boolean;
  purchaseItem: (itemId: string, scope: "user" | "org", workspaceId?: string) => Promise<string | null>;
  saveToSpace: (contentId: string, destination: "personal" | "org", workspaceId?: string) => Promise<string | null>;
  invalidateCache: () => void;
}

const PlatformLibraryContext = createContext<PlatformLibraryState | null>(null);

export function PlatformLibraryProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<PlatformItem[]>([]);
  const [entitlements, setEntitlements] = useState<UserEntitlement[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchItems = useCallback(async (type?: PlatformItemType) => {
    setLoading(true);
    setError(null);
    try {
      const result = await PlatformLibraryService.getItems(type ? { type } : undefined);
      setItems(result);
    } catch (err: any) {
      setError(err.message || "Failed to load platform items");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchItem = useCallback(async (slug: string): Promise<PlatformItemDetail | null> => {
    try {
      return await PlatformLibraryService.getItem(slug);
    } catch {
      return null;
    }
  }, []);

  const fetchEntitlements = useCallback(async () => {
    try {
      const result = await PlatformLibraryService.getMyEntitlements();
      setEntitlements(result);
    } catch {
      // silent
    }
  }, []);

  const hasAccess = useCallback(
    (itemId: string) => {
      const item = items.find((i) => i.id === itemId);
      if (item?.is_free) return true;
      if (item?.user_has_access) return true;
      return entitlements.some((e) => e.platform_item_id === itemId && e.is_active);
    },
    [items, entitlements]
  );

  const purchaseItem = useCallback(
    async (itemId: string, scope: "user" | "org", workspaceId?: string): Promise<string | null> => {
      try {
        const result = await PlatformLibraryService.purchase(itemId, scope, workspaceId);
        return result.checkout_url;
      } catch (err: any) {
        setError(err.message);
        return null;
      }
    },
    []
  );

  const saveToSpace = useCallback(
    async (contentId: string, destination: "personal" | "org", workspaceId?: string): Promise<string | null> => {
      try {
        const result = await PlatformLibraryService.saveToSpace(contentId, destination, workspaceId);
        return result.id;
      } catch (err: any) {
        setError(err.message);
        return null;
      }
    },
    []
  );

  const invalidateCache = useCallback(() => {
    fetchItems();
    fetchEntitlements();
  }, [fetchItems, fetchEntitlements]);

  return (
    <PlatformLibraryContext.Provider
      value={{
        items,
        entitlements,
        loading,
        error,
        fetchItems,
        fetchItem,
        fetchEntitlements,
        hasAccess,
        purchaseItem,
        saveToSpace,
        invalidateCache,
      }}
    >
      {children}
    </PlatformLibraryContext.Provider>
  );
}

export function usePlatformLibrary() {
  const ctx = useContext(PlatformLibraryContext);
  if (!ctx) {
    throw new Error("usePlatformLibrary must be used within PlatformLibraryProvider");
  }
  return ctx;
}

export function usePlatformItems(type?: PlatformItemType) {
  const { items, loading, error, fetchItems } = usePlatformLibrary();

  useEffect(() => {
    fetchItems(type);
  }, [type, fetchItems]);

  const filtered = type ? items.filter((i) => i.type === type) : items;
  return { items: filtered, loading, error, refetch: () => fetchItems(type) };
}
