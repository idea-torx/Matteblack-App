/** Only fal-owned https hosts may be reached through /api/fal/proxy. */
export function isFalHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return url.startsWith("https://") && (h === "fal.run" || h.endsWith(".fal.run") || h === "fal.ai" || h.endsWith(".fal.ai"));
  } catch {
    return false;
  }
}

