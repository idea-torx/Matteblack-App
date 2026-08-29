import type { TimelineState, TimelineClip } from "./timelineState";
import { getEffectiveDuration } from "./timelineState";

export type ExportConfig = {
  resolution: "source" | "720p" | "1080p";
  includeAudio: boolean;
  filename: string;
};

type ClipFileEntry = {
  clip: TimelineClip;
  filename: string;
};

export type StreamInfo = {
  hasAudio: boolean;
  isH264: boolean;
  width?: number;
  height?: number;
};

export function buildFFmpegCommand(
  timeline: TimelineState,
  clipFileMap: Map<string, string>,
  config: ExportConfig,
  totalDuration: number,
  streamInfoMap: Map<string, StreamInfo>
): { args: string[]; concatListContent?: string } {
  const videoTracks = timeline.tracks.filter((t) => t.type === "video");
  const audioTracks = timeline.tracks.filter((t) => t.type === "audio");

  const videoClips: ClipFileEntry[] = [];
  for (const track of videoTracks) {
    for (const clip of track.clips) {
      const filename = clipFileMap.get(clip.id);
      if (filename && clip.type === "video") {
        videoClips.push({ clip, filename });
      }
    }
  }
  videoClips.sort((a, b) => a.clip.startOffset - b.clip.startOffset);

  const audioClipsFromTimeline: ClipFileEntry[] = [];
  if (config.includeAudio) {
    for (const track of audioTracks) {
      for (const clip of track.clips) {
        const filename = clipFileMap.get(clip.id);
        if (filename) {
          audioClipsFromTimeline.push({ clip, filename });
        }
      }
    }

    for (const entry of videoClips) {
      const hasLinkedAudio = audioClipsFromTimeline.some(
        (ac) => ac.clip.linkedClipId === entry.clip.id || entry.clip.linkedClipId === ac.clip.id
      );
      if (!hasLinkedAudio) {
        const info = streamInfoMap.get(entry.clip.id);
        if (info?.hasAudio) {
          audioClipsFromTimeline.push({ clip: entry.clip, filename: entry.filename });
        }
      }
    }
  }

  const resolutionMap: Record<string, { w: number; h: number }> = {
    "720p": { w: 1280, h: 720 },
    "1080p": { w: 1920, h: 1080 },
  };

  const hasGaps = videoClips.length === 0 || videoClips[0].clip.startOffset > 0.01 ||
    videoClips.some((entry, i) => {
      if (i === 0) return false;
      const pEnd = videoClips[i - 1].clip.startOffset + getEffectiveDuration(videoClips[i - 1].clip);
      return entry.clip.startOffset > pEnd + 0.01;
    }) || (videoClips.length > 0 && (videoClips[videoClips.length - 1].clip.startOffset + getEffectiveDuration(videoClips[videoClips.length - 1].clip)) < totalDuration - 0.01);

  const hasTrim = videoClips.some((e) => e.clip.trimStart > 0.001 || e.clip.trimEnd > 0.001);
  const resolutionChange = config.resolution !== "source" && !!resolutionMap[config.resolution];
  const allH264 = videoClips.length > 0 && videoClips.every((e) => {
    const info = streamInfoMap.get(e.clip.id);
    return info?.isH264 ?? false;
  });
  const hasExternalAudio = audioClipsFromTimeline.some(
    (ac) => ac.clip.type === "audio"
  );
  const canPassthrough = allH264 && !resolutionChange && !hasGaps && !hasTrim && !hasExternalAudio;

  const outputName = config.filename.endsWith(".mp4") ? config.filename : `${config.filename}.mp4`;

  if (canPassthrough && videoClips.length === 1) {
    const entry = videoClips[0];
    const args: string[] = ["-i", entry.filename];

    args.push("-c:v", "copy");

    if (config.includeAudio) {
      const info = streamInfoMap.get(entry.clip.id);
      if (info?.hasAudio) {
        args.push("-c:a", "aac", "-b:a", "128k");
      } else {
        args.push("-an");
      }
    } else {
      args.push("-an");
    }

    args.push("-movflags", "+faststart");
    args.push(outputName);
    return { args };
  }

  if (canPassthrough && videoClips.length > 1) {
    const concatLines = videoClips.map((e) => `file '${e.filename}'`).join("\n");
    const args: string[] = [
      "-f", "concat",
      "-safe", "0",
      "-i", "concat_list.txt",
      "-c:v", "copy",
    ];

    if (config.includeAudio) {
      args.push("-c:a", "aac", "-b:a", "128k");
    } else {
      args.push("-an");
    }

    args.push("-movflags", "+faststart");
    args.push(outputName);
    return { args, concatListContent: concatLines };
  }

  const scaleFilter = resolutionChange
    ? `,scale=${resolutionMap[config.resolution].w}:${resolutionMap[config.resolution].h}:force_original_aspect_ratio=decrease,pad=${resolutionMap[config.resolution].w}:${resolutionMap[config.resolution].h}:(ow-iw)/2:(oh-ih)/2:color=black`
    : "";

  const firstClipInfo = videoClips.length > 0 ? streamInfoMap.get(videoClips[0].clip.id) : undefined;
  const firstClipDims = {
    w: firstClipInfo?.width || 1920,
    h: firstClipInfo?.height || 1080,
  };
  const res = resolutionMap[config.resolution] || firstClipDims;

  const filterParts: string[] = [];
  const inputArgs: string[] = [];
  let inputIdx = 0;
  const videoSegmentLabels: string[] = [];
  const mixAudioLabels: string[] = [];
  let prevEnd = 0;

  let blackIdx = -1;
  if (hasGaps) {
    inputArgs.push("-f", "lavfi", "-i", `color=c=black:s=${res.w}x${res.h}:r=30:d=${totalDuration}`);
    blackIdx = inputIdx++;
  }

  const videoInputIndexMap = new Map<string, number>();

  for (const entry of videoClips) {
    const effDur = getEffectiveDuration(entry.clip);
    const gapDuration = entry.clip.startOffset - prevEnd;

    if (gapDuration > 0.01 && blackIdx >= 0) {
      const gapLabel = `gap${videoSegmentLabels.length}`;
      filterParts.push(`[${blackIdx}:v]trim=start=0:end=${gapDuration.toFixed(4)},setpts=PTS-STARTPTS${scaleFilter}[${gapLabel}]`);
      videoSegmentLabels.push(`[${gapLabel}]`);
    }

    inputArgs.push("-i", entry.filename);
    const thisIdx = inputIdx++;
    videoInputIndexMap.set(entry.clip.id, thisIdx);
    const vLabel = `v${videoSegmentLabels.length}`;
    filterParts.push(
      `[${thisIdx}:v]trim=start=${entry.clip.trimStart.toFixed(4)}:end=${(entry.clip.duration - entry.clip.trimEnd).toFixed(4)},setpts=PTS-STARTPTS${scaleFilter}[${vLabel}]`
    );
    videoSegmentLabels.push(`[${vLabel}]`);

    prevEnd = entry.clip.startOffset + effDur;
  }

  const trailingGap = totalDuration - prevEnd;
  if (trailingGap > 0.01 && blackIdx >= 0) {
    const gapLabel = `gapend`;
    filterParts.push(`[${blackIdx}:v]trim=start=0:end=${trailingGap.toFixed(4)},setpts=PTS-STARTPTS${scaleFilter}[${gapLabel}]`);
    videoSegmentLabels.push(`[${gapLabel}]`);
  }

  if (config.includeAudio) {
    for (const entry of audioClipsFromTimeline) {
      const info = streamInfoMap.get(entry.clip.id);
      const isVideoClipUsedAsAudio = entry.clip.type === "video";

      let thisIdx: number;
      if (isVideoClipUsedAsAudio) {
        const existingIdx = videoInputIndexMap.get(entry.clip.id);
        if (existingIdx !== undefined) {
          thisIdx = existingIdx;
        } else {
          inputArgs.push("-i", entry.filename);
          thisIdx = inputIdx++;
        }
      } else {
        inputArgs.push("-i", entry.filename);
        thisIdx = inputIdx++;
      }

      if (isVideoClipUsedAsAudio && !(info?.hasAudio)) {
        continue;
      }

      const aLabel = `a${mixAudioLabels.length}`;
      const vol = entry.clip.volume ?? 1;
      filterParts.push(
        `[${thisIdx}:a]atrim=start=${entry.clip.trimStart.toFixed(4)}:end=${(entry.clip.duration - entry.clip.trimEnd).toFixed(4)},asetpts=PTS-STARTPTS,volume=${vol.toFixed(2)},adelay=${Math.round(entry.clip.startOffset * 1000)}|${Math.round(entry.clip.startOffset * 1000)},apad=whole_dur=${totalDuration.toFixed(4)}[${aLabel}]`
      );
      mixAudioLabels.push(`[${aLabel}]`);
    }
  }

  let filterComplex = filterParts.join(";\n");

  if (videoSegmentLabels.length > 1) {
    filterComplex += `;\n${videoSegmentLabels.join("")}concat=n=${videoSegmentLabels.length}:v=1:a=0[outv]`;
  } else if (videoSegmentLabels.length === 1) {
    filterComplex += `;\n${videoSegmentLabels[0]}null[outv]`;
  }

  if (config.includeAudio && mixAudioLabels.length > 1) {
    filterComplex += `;\n${mixAudioLabels.join("")}amix=inputs=${mixAudioLabels.length}:duration=longest:dropout_transition=0[outa]`;
  } else if (config.includeAudio && mixAudioLabels.length === 1) {
    filterComplex += `;\n${mixAudioLabels[0]}anull[outa]`;
  }

  const args: string[] = [...inputArgs];
  args.push("-filter_complex", filterComplex);
  args.push("-map", "[outv]");

  if (config.includeAudio && mixAudioLabels.length > 0) {
    args.push("-map", "[outa]");
    args.push("-c:a", "aac", "-b:a", "128k");
  } else {
    args.push("-an");
  }

  args.push("-c:v", "libx264", "-preset", "fast", "-crf", "23");
  args.push("-pix_fmt", "yuv420p");
  args.push("-movflags", "+faststart");

  args.push(outputName);

  return { args };
}
