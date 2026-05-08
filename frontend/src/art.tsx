import { useId, type CSSProperties } from "react";

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
    <svg width={size} height={size} viewBox="0 0 40 40" style={style}>
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
      <svg width={size} height={size} viewBox="0 0 60 60">
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
    <svg width={width} height="14" viewBox="0 0 200 14" preserveAspectRatio="none" style={style}>
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

export function BraidedTrail({ scores, width = 720, height = 220 }: { scores: BraidedTrailScores; width?: number; height?: number }) {
  const colors: Array<[keyof BraidedTrailScores, string, string]> = [
    ["hook", "var(--tomato)", "Hook"],
    ["memory", "var(--pistachio)", "Memory"],
    ["attention", "var(--butter)", "Attention"],
    ["load", "var(--plum)", "Load"]
  ];
  function pathFor(score: number, phase: number, ampMul: number): string {
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
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} style={{ overflow: "visible" }}>
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
        const ampMul = k === "load" ? -1 : 1;
        const d = pathFor(scores[k] ?? 50, i * 0.9, ampMul);
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
