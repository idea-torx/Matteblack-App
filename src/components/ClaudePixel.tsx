import { useEffect, useState } from "react";

/**
 * Claude, as a pixel sprite, for the operator panel header.
 *
 * Replaces the old QuantumThinking atom. The silhouette is Claude Code's mascot
 * — wide body, two eye slots, arms breaking the side edges, four legs — recoloured
 * to Matteblack blue because he's running inside Matteblack rather than a terminal.
 *
 * Idle glances around on long, irregular pauses — alive but clearly not working.
 * While `thinking`, three animations cycle so a long agent turn doesn't loop one
 * gesture hypnotically:
 *
 *   scan   eyes track left/right — reading
 *   hop    body lifts off its legs — working
 *   pulse  arms extend and retract — sensing
 *
 * Frames are 16x11 character grids ('#' = pixel) rather than CSS transforms, so
 * the motion is real sprite animation and stays crisp at any size. Each step
 * carries its own duration, which is what lets idle hold still for seconds at a
 * time between glances.
 */

const W = 16;
const H = 11;

/** Base pose. Every frame below is a variation on this. */
const BASE = [
  "..############..",
  "..############..",
  "..##.######.##..",
  "..##.######.##..",
  "################",
  "################",
  "..############..",
  "..############..",
  "..############..",
  "...#.#....#.#...",
  "...#.#....#.#...",
];

/** Swap the two eye rows (rows 2-3) for a different eye position. */
function withEyes(row: string): string[] {
  return BASE.map((r, i) => (i === 2 || i === 3 ? row : r));
}

/** Swap the two arm rows (rows 4-5) for a different arm extension. */
function withArms(row: string): string[] {
  return BASE.map((r, i) => (i === 4 || i === 5 ? row : r));
}

const EYES_CENTER = "..##.######.##..";
const EYES_LEFT = "..#.######.###..";
const EYES_RIGHT = "..###.######.#..";

const ARMS_OUT = "################";
const ARMS_MID = ".##############.";
const ARMS_IN = "..############..";

const CENTER = withEyes(EYES_CENTER);
const LEFT = withEyes(EYES_LEFT);
const RIGHT = withEyes(EYES_RIGHT);

/** Body lifted one row, leaving a gap under the legs. */
const HOP_UP = [...BASE.slice(1), ".".repeat(W)];

interface Step {
  grid: string[];
  ms: number;
}

const uniform = (frames: string[][], ms: number): Step[] =>
  frames.map((grid) => ({ grid, ms }));

/**
 * Idle: the same left/right scan as `thinking`, but mostly holding still. The
 * holds are deliberately uneven — evenly spaced glances read as a metronome,
 * which looks more mechanical than doing nothing at all. Loops about every 7s.
 */
const IDLE: Step[] = [
  { grid: CENTER, ms: 1200 },
  { grid: LEFT, ms: 200 },
  { grid: CENTER, ms: 1500 },
  { grid: RIGHT, ms: 190 },
  { grid: CENTER, ms: 900 },
  { grid: RIGHT, ms: 170 },
  { grid: CENTER, ms: 1800 },
  { grid: LEFT, ms: 210 },
  { grid: CENTER, ms: 1000 },
];

interface Anim {
  name: string;
  steps: Step[];
}

const THINKING: Anim[] = [
  { name: "scan", steps: uniform([CENTER, LEFT, CENTER, RIGHT], 260) },
  { name: "hop", steps: uniform([BASE, HOP_UP, BASE, BASE], 180) },
  {
    name: "pulse",
    steps: uniform(
      [withArms(ARMS_OUT), withArms(ARMS_MID), withArms(ARMS_IN), withArms(ARMS_MID)],
      200
    ),
  },
];

/** Full cycles of one thinking animation before handing over to the next. */
const LOOPS_PER_ANIM = 2;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

interface ClaudePixelProps {
  /** Rendered width in px. Height follows the 16:11 sprite ratio. */
  size?: number;
  /** Run the thinking loops. When false he idles. */
  thinking?: boolean;
  color?: string;
  className?: string;
  ariaLabel?: string;
}

export function ClaudePixel({
  size = 28,
  thinking = false,
  color = "#007AFF",
  className,
  ariaLabel = "Claude",
}: ClaudePixelProps) {
  const [animIndex, setAnimIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const still = prefersReducedMotion();

  // Restart cleanly whenever we cross between idle and thinking. Adjusted during
  // render rather than in an effect — React re-runs the render before committing,
  // so the sprite never paints a frame from the previous mode.
  const [prevThinking, setPrevThinking] = useState(thinking);
  if (prevThinking !== thinking) {
    setPrevThinking(thinking);
    setAnimIndex(0);
    setStepIndex(0);
  }

  const steps = thinking ? THINKING[animIndex].steps : IDLE;

  useEffect(() => {
    if (still) return;
    const current = steps[stepIndex % steps.length];
    const id = window.setTimeout(() => {
      const next = stepIndex + 1;
      // Thinking hands over to the next animation after LOOPS_PER_ANIM passes;
      // idle just loops itself forever.
      if (thinking && next >= steps.length * LOOPS_PER_ANIM) {
        setAnimIndex((a) => (a + 1) % THINKING.length);
        setStepIndex(0);
      } else {
        setStepIndex(next);
      }
    }, current.ms);
    return () => window.clearTimeout(id);
  }, [still, steps, stepIndex, thinking]);

  const grid = still ? BASE : steps[stepIndex % steps.length].grid;

  const px: Array<[number, number]> = [];
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === "#") px.push([x, y]);
  });

  return (
    <span
      className={className}
      role="status"
      aria-label={thinking ? `${ariaLabel} is thinking` : ariaLabel}
      style={{ display: "inline-flex", width: size, lineHeight: 0 }}
    >
      <svg
        width={size}
        height={Math.round((size * H) / W)}
        viewBox={`0 0 ${W} ${H}`}
        shapeRendering="crispEdges"
        aria-hidden="true"
      >
        {px.map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={color} />
        ))}
      </svg>
    </span>
  );
}

export default ClaudePixel;
