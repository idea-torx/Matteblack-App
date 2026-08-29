import React from "react";
import { useVideoThumbnail } from "../hooks/useVideoThumbnail";

interface ClipThumbnailProps {
  src: string;
}

export const ClipThumbnail: React.FC<ClipThumbnailProps> = React.memo(({ src }) => {
  const thumbnail = useVideoThumbnail(src);

  if (!thumbnail) return null;

  return (
    <div
      className="cinema-timeline__clip-thumbnail"
      style={{
        backgroundImage: `url(${thumbnail})`,
      }}
    />
  );
});

ClipThumbnail.displayName = "ClipThumbnail";
