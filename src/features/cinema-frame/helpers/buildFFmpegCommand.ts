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
  fps?: number;
  frames?: number;
  /** Near-duplicate frames at the head / tail of the clip (a parked seam pose). */
  headHold?: number;
  tailHold?: number;
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
  // Clips whose track is muted still render picture — they just contribute no
  // audio to the mix. Tracked by clip id because the audio pass below works
  // from flat clip lists that have lost which track they came from.
  const mutedVideoClipIds = new Set<string>();
  for (const track of videoTracks) {
    for (const clip of track.clips) {
      const filename = clipFileMap.get(clip.id);
      if (filename && (clip.type === "video" || clip.type === "image")) {
        videoClips.push({ clip, filename });
        if (track.muted) mutedVideoClipIds.add(clip.id);
      }
    }
  }
  videoClips.sort((a, b) => a.clip.startOffset - b.clip.startOffset);

  const audioClipsFromTimeline: ClipFileEntry[] = [];
  if (config.includeAudio) {
    for (const track of audioTracks) {
      if (track.muted) continue;
      for (const clip of track.clips) {
        const filename = clipFileMap.get(clip.id);
        // A video dropped on the timeline gets a MIRROR clip on the audio track
        // carrying that video's own audio. Muting the video track has to drop
        // the mirror too, or the sound comes back in through the side door.
        if (clip.linkedClipId && mutedVideoClipIds.has(clip.linkedClipId)) continue;
        if (filename) {
          audioClipsFromTimeline.push({ clip, filename });
        }
      }
    }

    for (const entry of videoClips) {
      if (mutedVideoClipIds.has(entry.clip.id)) continue;
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
    // Fal source clips can carry an absurd SPS level (6.2) that iOS download
    // paths reject even though playback works; rewrite it without re-encoding.
    args.push("-bsf:v", "h264_metadata=level=5.1");

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


  const scaleFilter = resolutionChange
    ? `,scale=${resolutionMap[config.resolution].w}:${resolutionMap[config.resolution].h}:force_original_aspect_ratio=decrease,pad=${resolutionMap[config.resolution].w}:${resolutionMap[config.resolution].h}:(ow-iw)/2:(oh-ih)/2:color=black`
    : "";

  const firstVideo = videoClips.find((e) => e.clip.type === "video");
  const firstClipInfo = firstVideo ? streamInfoMap.get(firstVideo.clip.id) : undefined;
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
  // Every clip in a chain ends on the frame the next one starts on (the seam
  // frame is generated twice), and the model parks the subject for a few
  // frames either side of it. Drop the seam frame plus the parked run from
  // each side, by frame index: the container (audio) often outlasts the last
  // video frame, so a time cut can land past it and drop nothing. Audio riding
  // on those clips shifts with them; standalone audio keeps absolute time.
  const seamCut = new Map<string, { start: number; end: number; endFrame?: number; shift: number }>();
  let shift = 0;
  videoClips.forEach((entry, i) => {
    const info = streamInfoMap.get(entry.clip.id);
    const fps = info?.fps || 24;
    const isVideo = entry.clip.type === "video";
    const headDrop = isVideo && i > 0 ? info?.headHold ?? 0 : 0;
    const tailDrop = isVideo && i < videoClips.length - 1 ? 1 + (info?.tailHold ?? 0) : 0;
    const start = Math.max(entry.clip.trimStart, headDrop / fps);
    const endFrame = tailDrop && info?.frames ? info.frames - tailDrop : undefined;
    const end = endFrame !== undefined ? endFrame / fps : entry.clip.duration - entry.clip.trimEnd - tailDrop / fps;
    seamCut.set(entry.clip.id, { start, end, endFrame, shift });
    shift += start - entry.clip.trimStart + (entry.clip.duration - entry.clip.trimEnd - end);
  });

  for (const entry of videoClips) {
    const effDur = getEffectiveDuration(entry.clip);
    const gapDuration = entry.clip.startOffset - prevEnd;

    if (gapDuration > 0.01 && blackIdx >= 0) {
      const gapLabel = `gap${videoSegmentLabels.length}`;
      filterParts.push(`[${blackIdx}:v]trim=start=0:end=${gapDuration.toFixed(4)},setpts=PTS-STARTPTS${scaleFilter}[${gapLabel}]`);
      videoSegmentLabels.push(`[${gapLabel}]`);
    }

    // A still (end card, title) is looped into a clip of its own duration and
    // scaled to the export frame so concat accepts it beside the video clips.
    const isImage = entry.clip.type === "image";
    if (isImage) inputArgs.push("-loop", "1", "-framerate", "30", "-t", effDur.toFixed(4));
    inputArgs.push("-i", entry.filename);
    const thisIdx = inputIdx++;
    videoInputIndexMap.set(entry.clip.id, thisIdx);
    const vLabel = `v${videoSegmentLabels.length}`;
    const imageFilter = `,scale=${res.w}:${res.h}:force_original_aspect_ratio=decrease,pad=${res.w}:${res.h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`;
    filterParts.push(
      `[${thisIdx}:v]trim=start=${seamCut.get(entry.clip.id)!.start.toFixed(4)}:${seamCut.get(entry.clip.id)!.endFrame !== undefined ? `end_frame=${seamCut.get(entry.clip.id)!.endFrame}` : `end=${seamCut.get(entry.clip.id)!.end.toFixed(4)}`},setpts=PTS-STARTPTS${isImage ? imageFilter : scaleFilter}[${vLabel}]`
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

      // Covers mirror clips too: an audio-track clip whose src is a SILENT
      // video would otherwise put a nonexistent [N:a] stream in the filter
      // graph and fail the whole encode.
      if (!(info?.hasAudio)) {
        continue;
      }

      const aLabel = `a${mixAudioLabels.length}`;
      const vol = entry.clip.volume ?? 1;
      const cut = seamCut.get(entry.clip.linkedClipId ?? entry.clip.id);
      const aStart = cut?.start ?? entry.clip.trimStart;
      const aEnd = cut?.end ?? entry.clip.duration - entry.clip.trimEnd;
      const delay = Math.round((entry.clip.startOffset - (cut?.shift ?? 0)) * 1000);
      filterParts.push(
        `[${thisIdx}:a]atrim=start=${aStart.toFixed(4)}:end=${aEnd.toFixed(4)},asetpts=PTS-STARTPTS,volume=${vol.toFixed(2)},adelay=${delay}|${delay},apad=whole_dur=${totalDuration.toFixed(4)}[${aLabel}]`
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
    filterComplex += `;\n${mixAudioLabels.join("")}amix=inputs=${mixAudioLabels.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.891[outa]`;
  } else if (config.includeAudio && mixAudioLabels.length === 1) {
    filterComplex += `;\n${mixAudioLabels[0]}alimiter=limit=0.891[outa]`;
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
  // Without an explicit level x264 in the wasm build writes SPS level 6.2 (the
  // concat graph's microsecond timebase reads as a huge frame rate), and iOS
  // refuses the file. Same cap the passthrough branch rewrites to.
  args.push("-profile:v", "high", "-level:v", "5.1");
  args.push("-movflags", "+faststart");
  args.push("-t", totalDuration.toFixed(4));

  args.push(outputName);

  return { args };
}
