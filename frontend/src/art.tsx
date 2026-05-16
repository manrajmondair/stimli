import { useId, useMemo, useRef, useState, type CSSProperties } from "react";

import type { TimelinePoint } from "./types";

type BrainBlobProps = {
  color?: string;
  size?: number;
  rotation?: number;
  eyes?: boolean;
  mouth?: boolean;
  style?: CSSProperties;
};

export function BrainBlob({
  color = "var(--tomato)",
  size = 220,
  rotation = 0,
  eyes = false,
  mouth = false,
  style = {}
}: BrainBlobProps) {
  const id = useId();
  const shade = `color-mix(in oklch, ${color} 65%, var(--ink) 35%)`;
  const highlight = `color-mix(in oklch, ${color} 80%, white 20%)`;
  const sw = Math.max(1.4, 3 * Math.min(1, 220 / Math.max(48, size)));
  const fineSw = Math.max(1, sw * 0.75);
  const clipId = `brain-clip-${id.replace(/:/g, "")}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 220 220"
      style={{ overflow: "visible", transform: `rotate(${rotation}deg)`, ...style }}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}>
          <path d="M 110 14 C 138 10 162 22 174 42 C 196 44 208 66 204 92 C 214 110 210 136 196 150 C 198 176 176 198 150 196 C 138 210 116 212 102 202 C 84 212 60 206 50 188 C 28 188 12 168 18 144 C 6 128 8 100 24 86 C 22 60 42 38 68 38 C 80 22 96 14 110 14 Z" />
        </clipPath>
      </defs>

      <path
        d="M 96 188 Q 100 208 110 212 Q 120 208 124 188 Z"
        fill={shade}
        stroke="var(--ink)"
        strokeWidth={sw}
        strokeLinejoin="round"
      />

      <path
        d="M 138 178 Q 162 178 168 196 Q 152 206 132 198 Q 126 188 138 178 Z"
        fill={shade}
        stroke="var(--ink)"
        strokeWidth={sw}
        strokeLinejoin="round"
      />

      <path
        d="M 110 14 C 138 10 162 22 174 42 C 196 44 208 66 204 92 C 214 110 210 136 196 150 C 198 176 176 198 150 196 C 138 210 116 212 102 202 C 84 212 60 206 50 188 C 28 188 12 168 18 144 C 6 128 8 100 24 86 C 22 60 42 38 68 38 C 80 22 96 14 110 14 Z"
        fill={color}
        stroke="var(--ink)"
        strokeWidth={sw}
        strokeLinejoin="round"
      />

      <g clipPath={`url(#${clipId})`}>
        <ellipse cx="74" cy="58" rx="34" ry="20" fill={highlight} opacity="0.55" />
      </g>

      <g clipPath={`url(#${clipId})`} fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M 110 16 Q 104 48 112 78 Q 102 108 116 138 Q 104 168 112 200" stroke={shade} strokeWidth={sw + 1.5} />
        <path d="M 110 16 Q 104 48 112 78 Q 102 108 116 138 Q 104 168 112 200" stroke="var(--ink)" strokeWidth={fineSw} />

        <path d="M 38 60 Q 56 48 76 60 Q 88 70 78 86" stroke={shade} strokeWidth={sw + 1} />
        <path d="M 38 60 Q 56 48 76 60 Q 88 70 78 86" stroke="var(--ink)" strokeWidth={fineSw} />

        <path d="M 28 88 Q 54 80 70 96 Q 60 110 78 120" stroke={shade} strokeWidth={sw + 1} />
        <path d="M 28 88 Q 54 80 70 96 Q 60 110 78 120" stroke="var(--ink)" strokeWidth={fineSw} />

        <path d="M 64 30 Q 78 64 70 100 Q 78 130 62 156" stroke={shade} strokeWidth={sw + 1} />
        <path d="M 64 30 Q 78 64 70 100 Q 78 130 62 156" stroke="var(--ink)" strokeWidth={fineSw} />

        <path d="M 30 130 Q 54 124 64 142 Q 50 158 70 170" stroke={shade} strokeWidth={sw + 1} />
        <path d="M 30 130 Q 54 124 64 142 Q 50 158 70 170" stroke="var(--ink)" strokeWidth={fineSw} />

        <path d="M 50 168 Q 72 164 86 178" stroke={shade} strokeWidth={sw + 1} />
        <path d="M 50 168 Q 72 164 86 178" stroke="var(--ink)" strokeWidth={fineSw} />

        <path d="M 144 50 Q 168 56 180 72 Q 168 84 156 80" stroke={shade} strokeWidth={sw + 1} />
        <path d="M 144 50 Q 168 56 180 72 Q 168 84 156 80" stroke="var(--ink)" strokeWidth={fineSw} />

        <path d="M 154 86 Q 184 90 192 110 Q 178 120 156 116" stroke={shade} strokeWidth={sw + 1} />
        <path d="M 154 86 Q 184 90 192 110 Q 178 120 156 116" stroke="var(--ink)" strokeWidth={fineSw} />

        <path d="M 152 30 Q 142 70 154 104 Q 144 134 158 158" stroke={shade} strokeWidth={sw + 1} />
        <path d="M 152 30 Q 142 70 154 104 Q 144 134 158 158" stroke="var(--ink)" strokeWidth={fineSw} />

        <path d="M 158 124 Q 184 130 196 146 Q 178 158 162 154" stroke={shade} strokeWidth={sw + 1} />
        <path d="M 158 124 Q 184 130 196 146 Q 178 158 162 154" stroke="var(--ink)" strokeWidth={fineSw} />

        <path d="M 132 168 Q 152 162 168 180" stroke={shade} strokeWidth={sw + 1} />
        <path d="M 132 168 Q 152 162 168 180" stroke="var(--ink)" strokeWidth={fineSw} />

        <path d="M 38 132 Q 56 152 86 156 Q 96 152 100 142" stroke={shade} strokeWidth={sw + 1.5} />
        <path d="M 38 132 Q 56 152 86 156 Q 96 152 100 142" stroke="var(--ink)" strokeWidth={fineSw} />

        <path d="M 184 132 Q 168 152 138 156 Q 128 152 124 142" stroke={shade} strokeWidth={sw + 1.5} />
        <path d="M 184 132 Q 168 152 138 156 Q 128 152 124 142" stroke="var(--ink)" strokeWidth={fineSw} />
      </g>

      <g clipPath={`url(#${clipId})`} fill="none" stroke="var(--ink)" strokeWidth={fineSw} strokeLinecap="round">
        <path d="M 142 184 Q 152 188 162 184" />
        <path d="M 140 192 Q 152 196 164 192" />
      </g>

      {(eyes || mouth) && (
        <g clipPath={`url(#${clipId})`}>
          <ellipse cx="110" cy="118" rx="58" ry="44" fill={highlight} opacity="0.7" />
          <ellipse cx="110" cy="118" rx="58" ry="44" fill={color} opacity="0.55" />
        </g>
      )}
      {eyes && (
        <g>
          <ellipse cx="86" cy="112" rx="6" ry="8" fill="var(--ink)" />
          <ellipse cx="134" cy="112" rx="6" ry="8" fill="var(--ink)" />
          <circle cx="88" cy="109" r="2.2" fill="var(--paper)" />
          <circle cx="136" cy="109" r="2.2" fill="var(--paper)" />
          <ellipse cx="74" cy="132" rx="6" ry="3.5" fill="var(--tomato)" opacity="0.55" />
          <ellipse cx="146" cy="132" rx="6" ry="3.5" fill="var(--tomato)" opacity="0.55" />
        </g>
      )}
      {mouth && (
        <g>
          <path
            d="M 96 138 Q 110 152 124 138"
            fill="none"
            stroke="var(--ink)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M 102 144 Q 110 150 118 144" fill="var(--tomato)" opacity="0.6" stroke="none" />
        </g>
      )}
    </svg>
  );
}

type RibbonProps = {
  color?: string;
  width?: number;
  height?: number;
  amp?: number;
  freq?: number;
  thickness?: number;
  phase?: number;
  dashed?: boolean;
  className?: string;
  style?: CSSProperties;
};

export function Ribbon({
  color = "var(--tomato)",
  width = 600,
  height = 120,
  amp = 30,
  freq = 4,
  thickness = 14,
  phase = 0,
  dashed = false,
  className = "",
  style = {}
}: RibbonProps) {
  const steps = 30;
  let d = `M 0 ${height / 2}`;
  for (let i = 1; i <= steps; i++) {
    const x = (i / steps) * width;
    const y = height / 2 + Math.sin((i / steps) * Math.PI * freq + phase) * amp;
    const px = ((i - 0.5) / steps) * width;
    const py = height / 2 + Math.sin(((i - 0.5) / steps) * Math.PI * freq + phase) * amp;
    d += ` Q ${px} ${py} ${x} ${y}`;
  }
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      style={{ overflow: "visible", ...style }}
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} stroke="var(--ink)" strokeWidth={thickness + 4} strokeLinecap="round" fill="none" />
      <path
        d={d}
        stroke={color}
        strokeWidth={thickness}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={dashed ? "2 14" : "none"}
      />
    </svg>
  );
}

export function Sparkle({
  color = "var(--butter)",
  size = 40,
  style = {}
}: {
  color?: string;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" style={style} aria-hidden="true" focusable="false">
      <path
        d="M 20 2 Q 22 18 38 20 Q 22 22 20 38 Q 18 22 2 20 Q 18 18 20 2 Z"
        fill={color}
        stroke="var(--ink)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function StickerStar({
  color = "var(--butter)",
  size = 60,
  label = "",
  rot = -8,
  style = {}
}: {
  color?: string;
  size?: number;
  label?: string;
  rot?: number;
  style?: CSSProperties;
}) {
  return (
    <div style={{ position: "relative", display: "inline-block", transform: `rotate(${rot}deg)`, ...style }}>
      <svg width={size} height={size} viewBox="0 0 60 60" aria-hidden="true" focusable="false">
        <path
          d="M 30 2 L 36 22 L 58 24 L 40 36 L 48 58 L 30 46 L 12 58 L 20 36 L 2 24 L 24 22 Z"
          fill={color}
          stroke="var(--ink)"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
      {label && (
        <span
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            fontFamily: "var(--display)",
            fontSize: size * 0.3,
            color: "var(--ink)"
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
}

export function ScribbleUnderline({
  color = "var(--tomato)",
  width = 200,
  style = {}
}: {
  color?: string;
  width?: number;
  style?: CSSProperties;
}) {
  return (
    <svg width={width} height="14" viewBox="0 0 200 14" preserveAspectRatio="none" style={style} aria-hidden="true" focusable="false">
      <path d="M 4 8 Q 50 2 100 8 T 196 8" stroke={color} strokeWidth="3.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function MarbleBlob({
  color = "var(--tomato-soft)",
  size = 480,
  rot = 0,
  style = {}
}: {
  color?: string;
  size?: number;
  rot?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      style={{ position: "absolute", overflow: "visible", transform: `rotate(${rot}deg)`, ...style }}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M 60 20 C 110 6 178 28 184 80 C 192 134 156 184 100 188 C 50 192 8 156 12 100 C 16 54 34 30 60 20 Z"
        fill={color}
        opacity="0.85"
      />
    </svg>
  );
}

type ThoughtTrailProps = {
  width?: number;
  height?: number;
  intensity?: number;
  baseFreq?: number;
};

export function ThoughtTrail({ width = 720, height = 180, intensity = 1, baseFreq = 3 }: ThoughtTrailProps) {
  const colors = ["var(--tomato)", "var(--pistachio)", "var(--butter)", "var(--plum)"];
  return (
    <div style={{ position: "relative", width, height }}>
      {colors.map((c, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            inset: 0,
            transform: `translateY(${(i - 1.5) * 14}px)`,
            opacity: 0.95
          }}
        >
          <Ribbon
            color={c}
            width={width}
            height={height}
            amp={28 * intensity - i * 3}
            freq={baseFreq + i * 0.4}
            phase={i * 0.7}
            thickness={10 - i}
          />
        </div>
      ))}
    </div>
  );
}

type BraidedTrailScores = {
  hook: number;
  memory: number;
  attention: number;
  load: number;
};

export function BraidedTrail({
  scores,
  timeline,
  width = 720,
  height = 220
}: {
  scores: BraidedTrailScores;
  timeline?: TimelinePoint[];
  width?: number;
  height?: number;
}) {
  // When we have a real predicted-brain-response timeline, the braided trail
  // becomes the *stylized* view of that signal (Catmull-Rom smoothing applied
  // for a hand-drawn feel) — but its shape is no longer made-up sine waves.
  // The hook channel stays a static reference line at the hook score because
  // there's no per-second hook signal — hook is a single judgement of the
  // opening.
  const samples = timeline && timeline.length >= 2 ? timeline : null;
  const colors: Array<[keyof BraidedTrailScores, string]> = [
    ["hook", "var(--tomato)"],
    ["memory", "var(--pistachio)"],
    ["attention", "var(--butter)"],
    ["load", "var(--plum)"]
  ];

  const channelFor = (key: keyof BraidedTrailScores): keyof TimelinePoint | null => {
    switch (key) {
      case "attention":
        return "attention";
      case "memory":
        return "memory";
      case "load":
        return "cognitive_load";
      default:
        return null;
    }
  };

  function decorativePath(score: number, phase: number, ampMul: number): string {
    const steps = 28;
    const amp = (score / 100) * 60 * ampMul;
    const center = height / 2;
    let d = `M 0 ${center}`;
    for (let i = 1; i <= steps; i++) {
      const x = (i / steps) * width;
      const y =
        center +
        Math.sin((i / steps) * Math.PI * 4 + phase) * amp * 0.6 +
        Math.sin((i / steps) * Math.PI * 7 + phase * 1.3) * amp * 0.3;
      const cx = ((i - 0.5) / steps) * width;
      const cy = center + Math.sin(((i - 0.5) / steps) * Math.PI * 4 + phase) * amp * 0.6;
      d += ` Q ${cx} ${cy} ${x} ${y}`;
    }
    return d;
  }

  function timelinePath(channel: keyof TimelinePoint, ampMul: number): string {
    if (!samples) return "";
    const points: Array<[number, number]> = samples.map((point, idx) => {
      const x = (idx / Math.max(samples.length - 1, 1)) * width;
      const raw = Number(point[channel]);
      const value = Number.isFinite(raw) ? raw : 0.5;
      // Convert to a deviation from the channel's midline so all three
      // channels share the same vertical canvas. ampMul flips load so a
      // high load reads as an inverted curve (more load = more downward).
      const center = height / 2;
      const amp = (value - 0.5) * 120 * ampMul;
      const y = center - amp;
      return [x, y];
    });
    return catmullRomPath(points);
  }

  function hookReferencePath(score: number): string {
    // A gentle quadratic floor anchored at the hook score — represents the
    // 'opening promise' the rest of the curves are reacting against.
    const baseline = height / 2 - ((score - 50) / 50) * 50;
    return `M 0 ${baseline} Q ${width / 2} ${baseline - 8} ${width} ${baseline}`;
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      style={{ overflow: "visible" }}
      role="img"
      aria-label={samples ? "Predicted brain-response timeline" : "Stylized brain-response trail"}
    >
      {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
        <line
          key={i}
          x1={t * width}
          y1={20}
          x2={t * width}
          y2={height - 20}
          stroke="var(--line)"
          strokeWidth="1"
          strokeDasharray="3 5"
        />
      ))}
      {colors.map(([k, c], i) => {
        const channel = channelFor(k);
        let d: string;
        if (samples && channel) {
          const ampMul = k === "load" ? -1 : 1;
          d = timelinePath(channel, ampMul);
        } else if (samples && k === "hook") {
          d = hookReferencePath(scores[k] ?? 50);
        } else {
          const ampMul = k === "load" ? -1 : 1;
          d = decorativePath(scores[k] ?? 50, i * 0.9, ampMul);
        }
        return (
          <g key={k} style={{ transform: `translateY(${(i - 1.5) * 8}px)` }}>
            <path d={d} stroke="var(--ink)" strokeWidth={11} fill="none" strokeLinecap="round" />
            <path d={d} stroke={c} strokeWidth={8} fill="none" strokeLinecap="round" />
          </g>
        );
      })}
    </svg>
  );
}

// Catmull-Rom -> cubic-Bezier converter. Produces a smooth path through the
// sample points without the sine-wave fabrication the old BraidedTrail had.
function catmullRomPath(points: Array<[number, number]>): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    const [x, y] = points[0];
    return `M ${x} ${y}`;
  }
  const tension = 0.5;
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const cp1x = p1[0] + ((p2[0] - p0[0]) / 6) * tension * 2;
    const cp1y = p1[1] + ((p2[1] - p0[1]) / 6) * tension * 2;
    const cp2x = p2[0] - ((p3[0] - p1[0]) / 6) * tension * 2;
    const cp2y = p2[1] - ((p3[1] - p1[1]) / 6) * tension * 2;
    d += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${p2[0]} ${p2[1]}`;
  }
  return d;
}

// ---- NeuralTimeline -------------------------------------------------------
//
// Accurate, axis-aware plot of the predicted brain response. Plots attention,
// memory, and cognitive_load as separate time series, optionally overlaying
// multiple variants for direct comparison. Used as the "real chart" beneath
// the stylized BraidedTrail.
//
// Channels are shown as smoothed curves (Catmull-Rom) over the actual second
// axis, not a rescaled / hardcoded "0:00 hook / 0:08 build / ..." axis. The
// y-axis is 0-100, mirroring how the scores are presented elsewhere. Hover
// reveals exact values per channel at that second.

export type NeuralVariant = {
  id: string;
  label: string;
  color: string;
  timeline: TimelinePoint[];
};

type Channel = {
  key: "attention" | "memory" | "cognitive_load";
  label: string;
  color: string;
  description: string;
};

const NEURAL_CHANNELS: Channel[] = [
  { key: "attention", label: "Attention", color: "var(--butter)", description: "Predicted moment-to-moment viewer attention." },
  { key: "memory", label: "Memory", color: "var(--pistachio)", description: "Predicted memory encoding strength." },
  { key: "cognitive_load", label: "Load", color: "var(--plum)", description: "Predicted processing cost (lower is better)." }
];

const CHART_MARGIN = { top: 18, right: 18, bottom: 32, left: 38 };
const CHART_HEIGHT = 240;

export function NeuralTimeline({
  variants,
  activeVariantId,
  width = 720,
  visibleChannels: visibleChannelsProp
}: {
  variants: NeuralVariant[];
  activeVariantId?: string;
  width?: number;
  visibleChannels?: Array<Channel["key"]>;
}) {
  const usable = variants.filter((v) => v.timeline && v.timeline.length >= 2);

  const maxSecond = useMemo(() => {
    if (!usable.length) return 30;
    const seconds = usable.flatMap((v) => v.timeline.map((p) => Number(p.second) || 0));
    return Math.max(1, ...seconds);
  }, [usable]);

  const innerWidth = Math.max(120, width - CHART_MARGIN.left - CHART_MARGIN.right);
  const innerHeight = CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;
  const xFor = (second: number) => CHART_MARGIN.left + (second / Math.max(maxSecond, 0.001)) * innerWidth;
  const yFor = (valueZeroOne: number) => CHART_MARGIN.top + (1 - clamp01(valueZeroOne)) * innerHeight;

  const yTicks = [0, 25, 50, 75, 100];
  const tickCount = 6;
  const xTicks = Array.from({ length: tickCount + 1 }, (_, i) => round1((i / tickCount) * maxSecond));

  const [hoverSecond, setHoverSecond] = useState<number | null>(null);
  const [hiddenChannels, setHiddenChannels] = useState<Set<Channel["key"]>>(new Set());
  const svgRef = useRef<SVGSVGElement | null>(null);

  // When the caller passes visibleChannelsProp explicitly we treat it as
  // the source of truth and ignore the user's toggle state. When the prop
  // is undefined we let the user toggle locally via the legend.
  const visibleChannels: Array<Channel["key"]> = visibleChannelsProp
    ? visibleChannelsProp
    : NEURAL_CHANNELS.map((c) => c.key).filter((k) => !hiddenChannels.has(k));

  function handleMove(ev: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const scale = rect.width / width;
    const localX = (ev.clientX - rect.left) / scale - CHART_MARGIN.left;
    const ratio = clamp01(localX / innerWidth);
    setHoverSecond(round1(ratio * maxSecond));
  }

  function handleLeave() {
    setHoverSecond(null);
  }

  function handleKey(ev: React.KeyboardEvent<SVGSVGElement>) {
    const step = Math.max(0.1, round1(maxSecond / 40));
    const current = hoverSecond ?? maxSecond / 2;
    if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      setHoverSecond(round1(Math.max(0, current - step)));
    } else if (ev.key === "ArrowRight") {
      ev.preventDefault();
      setHoverSecond(round1(Math.min(maxSecond, current + step)));
    } else if (ev.key === "Home") {
      ev.preventDefault();
      setHoverSecond(0);
    } else if (ev.key === "End") {
      ev.preventDefault();
      setHoverSecond(round1(maxSecond));
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      setHoverSecond(null);
    }
  }

  function toggleChannel(key: Channel["key"]) {
    if (visibleChannelsProp) return; // controlled mode; toggles are no-ops
    setHiddenChannels((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else if (NEURAL_CHANNELS.length - next.size > 1) {
        // Never let the user hide the last visible channel.
        next.add(key);
      }
      return next;
    });
  }

  function valueAt(variant: NeuralVariant, channel: Channel["key"], second: number): number {
    const tl = variant.timeline;
    if (!tl.length) return 0;
    for (let i = 0; i < tl.length - 1; i++) {
      const a = tl[i];
      const b = tl[i + 1];
      if (second >= a.second && second <= b.second) {
        const span = Math.max(b.second - a.second, 0.001);
        const t = (second - a.second) / span;
        return clamp01(Number(a[channel]) * (1 - t) + Number(b[channel]) * t);
      }
    }
    return clamp01(Number(tl[Math.min(tl.length - 1, Math.max(0, Math.round((second / maxSecond) * (tl.length - 1))))]?.[channel] ?? 0));
  }

  const hoverX = hoverSecond != null ? xFor(hoverSecond) : null;

  if (!usable.length) {
    return (
      <div className="neural-timeline-empty" style={{ padding: 24, textAlign: "center", color: "var(--ink-soft)" }}>
        Predicted-response timeline isn't available for this comparison yet.
      </div>
    );
  }

  return (
    <div className="neural-timeline" role="figure" aria-label="Predicted brain response over time">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
        width="100%"
        height={CHART_HEIGHT}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        onKeyDown={handleKey}
        tabIndex={0}
        style={{ display: "block", overflow: "visible", outline: "none" }}
        role="img"
        aria-describedby="neural-timeline-instructions"
      >
        <rect
          x={CHART_MARGIN.left}
          y={CHART_MARGIN.top}
          width={innerWidth}
          height={innerHeight}
          fill="var(--paper-warm)"
          stroke="var(--ink)"
          strokeWidth={1.25}
          rx={6}
        />

        {yTicks.map((value) => (
          <g key={`y-${value}`}>
            <line
              x1={CHART_MARGIN.left}
              x2={CHART_MARGIN.left + innerWidth}
              y1={yFor(value / 100)}
              y2={yFor(value / 100)}
              stroke="var(--line)"
              strokeWidth={value === 50 ? 1.25 : 0.75}
              strokeDasharray={value === 50 ? "" : "3 4"}
            />
            <text
              x={CHART_MARGIN.left - 6}
              y={yFor(value / 100) + 3}
              textAnchor="end"
              fontSize="10"
              fill="var(--ink-soft)"
              fontFamily="var(--display)"
            >
              {value}
            </text>
          </g>
        ))}

        {xTicks.map((value, i) => (
          <g key={`x-${i}`}>
            <line
              x1={xFor(value)}
              x2={xFor(value)}
              y1={CHART_MARGIN.top + innerHeight}
              y2={CHART_MARGIN.top + innerHeight + 4}
              stroke="var(--ink)"
              strokeWidth={1}
            />
            <text
              x={xFor(value)}
              y={CHART_MARGIN.top + innerHeight + 16}
              textAnchor="middle"
              fontSize="10"
              fill="var(--ink-soft)"
              fontFamily="var(--display)"
            >
              {value.toFixed(1)}s
            </text>
          </g>
        ))}

        {usable.map((variant) =>
          NEURAL_CHANNELS.filter((c) => visibleChannels.includes(c.key)).map((channel) => {
            const isActive = !activeVariantId || activeVariantId === variant.id;
            const points: Array<[number, number]> = variant.timeline.map((point) => [xFor(Number(point.second)), yFor(Number(point[channel.key]))]);
            const path = catmullRomPath(points);
            const channelColor = channel.color;
            const variantOpacity = isActive ? 1 : 0.28;
            return (
              <g key={`${variant.id}-${channel.key}`} opacity={variantOpacity}>
                <path
                  d={path}
                  stroke="var(--ink)"
                  strokeWidth={isActive ? 4 : 2.5}
                  fill="none"
                  strokeLinecap="round"
                />
                <path
                  d={path}
                  stroke={channelColor}
                  strokeWidth={isActive ? 2.5 : 1.5}
                  fill="none"
                  strokeLinecap="round"
                  strokeDasharray={variant.id === activeVariantId || !activeVariantId ? "" : "4 4"}
                />
              </g>
            );
          })
        )}

        {hoverX != null && (
          <line
            x1={hoverX}
            x2={hoverX}
            y1={CHART_MARGIN.top}
            y2={CHART_MARGIN.top + innerHeight}
            stroke="var(--ink)"
            strokeWidth={0.75}
            strokeDasharray="2 3"
          />
        )}

        {hoverX != null && hoverSecond != null &&
          usable.map((variant) => {
            const isActive = !activeVariantId || activeVariantId === variant.id;
            return NEURAL_CHANNELS.filter((c) => visibleChannels.includes(c.key)).map((channel) => {
              const value = valueAt(variant, channel.key, hoverSecond);
              return (
                <circle
                  key={`hover-${variant.id}-${channel.key}`}
                  cx={hoverX}
                  cy={yFor(value)}
                  r={isActive ? 3.5 : 2.25}
                  fill={channel.color}
                  stroke="var(--ink)"
                  strokeWidth={1}
                  opacity={isActive ? 1 : 0.5}
                />
              );
            });
          })}
      </svg>

      <div className="neural-legend" aria-hidden="false">
        {NEURAL_CHANNELS.map((channel) => {
          const isVisible = visibleChannels.includes(channel.key);
          const controllable = !visibleChannelsProp;
          return controllable ? (
            <button
              type="button"
              key={channel.key}
              className={`neural-legend-item neural-legend-toggle ${isVisible ? "active" : "muted"}`}
              onClick={() => toggleChannel(channel.key)}
              aria-pressed={isVisible}
              aria-label={`${isVisible ? "Hide" : "Show"} ${channel.label} channel — ${channel.description}`}
            >
              <span className="swatch" style={{ background: channel.color, opacity: isVisible ? 1 : 0.35 }} />
              <strong>{channel.label}</strong>
              <span className="neural-legend-desc">{channel.description}</span>
            </button>
          ) : (
            <span key={channel.key} className={`neural-legend-item ${isVisible ? "active" : "muted"}`}>
              <span className="swatch" style={{ background: channel.color, opacity: isVisible ? 1 : 0.35 }} />
              <strong>{channel.label}</strong>
              <span className="neural-legend-desc">{channel.description}</span>
            </span>
          );
        })}
      </div>
      <p id="neural-timeline-instructions" className="neural-timeline-instructions">
        Hover or focus the chart and use Arrow keys / Home / End to scrub. Click a channel to hide it.
      </p>

      {hoverSecond != null && (
        <div className="neural-readout" aria-live="polite">
          <div className="neural-readout-time">{hoverSecond.toFixed(1)}s</div>
          <div className="neural-readout-grid">
            {usable.map((variant) => (
              <div key={variant.id} className="neural-readout-variant">
                <span className="swatch" style={{ background: variant.color }} />
                <strong>{variant.label}</strong>
                <div className="neural-readout-values">
                  {NEURAL_CHANNELS.filter((c) => visibleChannels.includes(c.key)).map((channel) => {
                    const value = valueAt(variant, channel.key, hoverSecond);
                    return (
                      <span key={channel.key} className="neural-readout-cell">
                        <span className="neural-readout-label">{channel.label}</span>
                        <span className="neural-readout-value">{Math.round(value * 100)}</span>
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
