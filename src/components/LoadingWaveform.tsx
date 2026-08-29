import { useEffect, useRef } from "react";
import "./LoadingWaveform.css";

type LoadingWaveformProps = {
  progress?: number;
  height?: number;
  waveColor?: string;
  isDone?: boolean;
};

const BAR_WIDTH = 2;
const BAR_GAP = 1.5;
const BAR_RADIUS = 1;

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function generateTargets(count: number): number[] {
  const targets: number[] = [];
  for (let i = 0; i < count; i++) {
    targets.push(Math.min(0.15 + Math.random() * 0.7, 1));
  }
  return targets;
}

export function LoadingWaveform({
  progress: _progress = 0,
  height = 48,
  waveColor = "rgba(96, 165, 250, 0.5)",
  isDone = false,
}: LoadingWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const currentHeights = useRef<number[]>([]);
  const targetHeights = useRef<number[]>([]);
  const barCountRef = useRef(0);
  const retargetTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const w = rect.width || 200;
      canvas.width = w * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const newCount = Math.max(Math.floor(w / (BAR_WIDTH + BAR_GAP)), 10);
      if (newCount !== barCountRef.current) {
        barCountRef.current = newCount;
        currentHeights.current = new Array(newCount).fill(0.2);
        targetHeights.current = generateTargets(newCount);
      }
    };
    resize();

    const lerpSpeed = 0.08;

    const draw = () => {
      const w = canvas.width / dpr;
      const h = height;
      const count = barCountRef.current;
      ctx.clearRect(0, 0, w, h);

      for (let i = 0; i < count; i++) {
        currentHeights.current[i] = lerp(
          currentHeights.current[i],
          targetHeights.current[i],
          lerpSpeed
        );
        const barH = Math.max(currentHeights.current[i] * h, 2);
        const x = i * (BAR_WIDTH + BAR_GAP);
        const y = (h - barH) / 2;

        ctx.beginPath();
        ctx.roundRect(x, y, BAR_WIDTH, barH, BAR_RADIUS);
        ctx.fillStyle = waveColor;
        ctx.fill();
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    draw();

    if (!isDone) {
      const retarget = () => {
        targetHeights.current = generateTargets(barCountRef.current);
      };
      retargetTimer.current = setInterval(retarget, 800);
    }

    return () => {
      cancelAnimationFrame(rafRef.current);
      if (retargetTimer.current) clearInterval(retargetTimer.current);
    };
  }, [height, waveColor, isDone]);

  return (
    <div className={`loading-waveform ${isDone ? "loading-waveform--fading" : ""}`}>
      <canvas ref={canvasRef} style={{ display: "block", width: "100%" }} />
    </div>
  );
}
