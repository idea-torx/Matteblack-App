export function probeMediaDuration(
  src: string,
  mediaType: "video" | "audio" | "image"
): Promise<number> {
  if (mediaType === "image") return Promise.resolve(3);

  return new Promise((resolve) => {
    const el = document.createElement(mediaType === "audio" ? "audio" : "video");
    let settled = false;
    const settle = (dur: number) => {
      if (settled) return;
      settled = true;
      el.src = "";
      el.remove();
      resolve(dur);
    };

    const timeout = setTimeout(() => settle(5), 8000);

    el.preload = "metadata";
    el.addEventListener("loadedmetadata", () => {
      clearTimeout(timeout);
      const d = el.duration;
      settle(Number.isFinite(d) && d > 0 ? d : 5);
    });
    el.addEventListener("error", () => {
      clearTimeout(timeout);
      settle(5);
    });
    el.src = src;
  });
}
