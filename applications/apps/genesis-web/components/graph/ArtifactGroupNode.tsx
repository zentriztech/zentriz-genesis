"use client";

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

export interface ArtifactGroupNodeData extends Record<string, unknown> {
  nodeType: "artifactGroup";
  dir: string;           // e.g. "auth", "routers", "models"
  files: { path: string; ext: string; sizeBytes: number }[];
  expanded: boolean;
  onToggle: () => void;
}

const EXT_COLOR: Record<string, string> = {
  tsx: "#61DAFB", ts: "#3178C6", js: "#F7DF1E", jsx: "#61DAFB",
  css: "#1572B6", scss: "#CC6699", json: "#F59E0B",
  md: "#8B949E", sh: "#10B981", py: "#3776AB",
};
const EXT_ICON: Record<string, string> = {
  tsx: "⚛", ts: "𝓣", js: "JS", jsx: "⚛", css: "🎨",
  scss: "🎨", json: "{}", md: "📄", sh: "⚡", py: "🐍",
};

function fmtSize(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

export const ArtifactGroupNode = memo(function ArtifactGroupNode({ data }: NodeProps) {
  const d = data as ArtifactGroupNodeData;

  // Unique extensions in this group for the badge strip
  const extSet = Array.from(new Set(d.files.map(f => f.ext))).slice(0, 5);
  const totalSize = d.files.reduce((s, f) => s + f.sizeBytes, 0);

  return (
    <div
      onClick={d.onToggle}
      style={{
        background: "#161B22",
        border: `1px solid ${d.expanded ? "#6366F1" : "#30363D"}`,
        borderRadius: 8,
        padding: "8px 12px",
        minWidth: 180,
        maxWidth: 230,
        cursor: "pointer",
        userSelect: "none",
        transition: "border-color 0.15s",
      }}
    >
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        {/* Folder icon */}
        <div style={{
          width: 30, height: 30, borderRadius: 6,
          background: d.expanded ? "#6366F122" : "#21262D",
          border: `1px solid ${d.expanded ? "#6366F140" : "#30363D"}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "1rem", flexShrink: 0, transition: "all 0.15s",
        }}>
          {d.expanded ? "📂" : "📁"}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "0.72rem", color: "#E6EDF3", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {d.dir || "apps/"}
          </div>
          <div style={{ fontSize: "0.6rem", color: "#8B949E" }}>
            {d.files.length} arquivo{d.files.length !== 1 ? "s" : ""} · {fmtSize(totalSize)}
          </div>
        </div>

        {/* Chevron */}
        <div style={{ color: "#8B949E", fontSize: "0.7rem", flexShrink: 0, transition: "transform 0.2s", transform: d.expanded ? "rotate(90deg)" : "rotate(0deg)" }}>
          ▶
        </div>
      </div>

      {/* Ext badges */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 6 }}>
        {extSet.map(ext => (
          <div key={ext} style={{
            padding: "1px 6px", borderRadius: 4,
            background: `${EXT_COLOR[ext] ?? "#8B949E"}20`,
            border: `1px solid ${EXT_COLOR[ext] ?? "#8B949E"}40`,
            fontSize: "0.58rem", color: EXT_COLOR[ext] ?? "#8B949E", fontWeight: 600,
          }}>
            {EXT_ICON[ext] ?? ext}
          </div>
        ))}
        {Array.from(new Set(d.files.map(f => f.ext))).length > 5 && (
          <div style={{ fontSize: "0.58rem", color: "#484F58", padding: "1px 4px" }}>+{Array.from(new Set(d.files.map(f => f.ext))).length - 5}</div>
        )}
      </div>

      {/* Expanded file list */}
      {d.expanded && (
        <div style={{ marginTop: 8, borderTop: "1px solid #21262D", paddingTop: 7, display: "flex", flexDirection: "column", gap: 3 }}>
          {d.files.map((f, i) => {
            const name  = f.path.split("/").pop() ?? f.path;
            const color = EXT_COLOR[f.ext] ?? "#8B949E";
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{
                  width: 18, height: 18, borderRadius: 3,
                  background: `${color}20`, border: `1px solid ${color}30`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: "0.5rem", fontWeight: 700, color, flexShrink: 0,
                }}>
                  {EXT_ICON[f.ext] ?? "·"}
                </div>
                <div style={{ fontSize: "0.62rem", color: "#C9D1D9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>
                  {name}
                </div>
                <div style={{ fontSize: "0.55rem", color: "#484F58", flexShrink: 0 }}>
                  {fmtSize(f.sizeBytes)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Handle type="target" position={Position.Left} style={{ background: "#6366F1", width: 6, height: 6, border: "none" }} />
    </div>
  );
});
