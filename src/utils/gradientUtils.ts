export interface GradientData {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color1: string;
  color2: string;
}

const GRADIENT_PREFIX = "gradient:";

export function isGradientFill(fill: string | undefined | null): boolean {
  return typeof fill === "string" && fill.startsWith(GRADIENT_PREFIX);
}

export function parseGradientFill(fill: string): GradientData | null {
  if (!fill.startsWith(GRADIENT_PREFIX)) return null;
  const parts = fill.slice(GRADIENT_PREFIX.length).split(",");
  if (parts.length < 6) return null;
  const x1 = parseFloat(parts[0]);
  const y1 = parseFloat(parts[1]);
  const x2 = parseFloat(parts[2]);
  const y2 = parseFloat(parts[3]);
  const color1 = parts[4];
  const color2 = parts[5];
  if ([x1, y1, x2, y2].some(isNaN)) return null;
  if (!color1 || !color2) return null;
  return { x1, y1, x2, y2, color1, color2 };
}

export function serializeGradientFill(data: GradientData): string {
  const { x1, y1, x2, y2, color1, color2 } = data;
  return `${GRADIENT_PREFIX}${x1.toFixed(3)},${y1.toFixed(3)},${x2.toFixed(3)},${y2.toFixed(3)},${color1},${color2}`;
}

export function gradientToCss(data: GradientData): string {
  const dx = data.x2 - data.x1;
  const dy = data.y2 - data.y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) {
    return data.color1;
  }
  const angleDeg = Math.atan2(dx, -dy) * (180 / Math.PI);
  const angleRad = angleDeg * (Math.PI / 180);
  const sinA = Math.sin(angleRad);
  const cosA = Math.cos(angleRad);
  const project = (px: number, py: number) => px * sinA + py * (-cosA);
  const p1 = project(data.x1, data.y1);
  const p2 = project(data.x2, data.y2);
  const corners = [
    project(0, 0), project(1, 0), project(0, 1), project(1, 1)
  ];
  const minP = Math.min(...corners);
  const maxP = Math.max(...corners);
  const range = maxP - minP;
  if (range < 0.001) return data.color1;
  const stop1 = ((p1 - minP) / range) * 100;
  const stop2 = ((p2 - minP) / range) * 100;
  return `linear-gradient(${angleDeg.toFixed(1)}deg, ${data.color1} ${stop1.toFixed(1)}%, ${data.color2} ${stop2.toFixed(1)}%)`;
}

export function gradientAngleDeg(data: GradientData): number {
  const dx = data.x2 - data.x1;
  const dy = data.y2 - data.y1;
  return Math.atan2(dy, dx) * (180 / Math.PI) + 90;
}

export function defaultGradientData(): GradientData {
  return { x1: 0, y1: 0.5, x2: 1, y2: 0.5, color1: "#5b5fc7", color2: "#c75b8f" };
}
