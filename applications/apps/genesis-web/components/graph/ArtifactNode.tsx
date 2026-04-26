"use client";

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { ArtifactNodeData } from "@/lib/useGraphData";

const EXT_COLOR: Record<string, string> = {
  tsx: "#61DAFB", ts: "#3178C6", js: "#F7DF1E", jsx: "#61DAFB",
  css: "#1572B6", scss: "#CC6699", json: "#F59E0B",
  md: "#8B949E", sh: "#10B981", py: "#3776AB",
};
const EXT_ICON: Record<string, string> = {
  tsx: "⚛", ts: "𝓣", js: "JS", jsx: "⚛", css: "🎨", scss: "🎨",
  json: "{}", md: "📄", sh: "⚡", py: "🐍",
};

function fmtSize(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

export const ArtifactNode = memo(function ArtifactNode({ data }: NodeProps) {
  const d     = data as ArtifactNodeData;
  const color = EXT_COLOR[d.ext] ?? "#8B949E";
  const icon  = EXT_ICON[d.ext] ?? "📁";
  const name  = d.path.split("/").pop() ?? d.path;
  const dir   = d.path.includes("/") ? d.path.split("/").slice(0, -1).join("/") : "";

  return (
    <div
      style={{
        background: "#161B22",
        border: `1px solid ${color}30`,
        borderRadius: 6,
        padding: "5px 9px",
        display: "flex", alignItems: "center", gap: 7,
        minWidth: 160, maxWidth: 200,
        cursor: "default",
      }}
    >
      {/* Ext badge */}
      <div style={{
        width: 28, height: 28, borderRadius: 5,
        background: `${color}20`, border: `1px solid ${color}40`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "0.65rem", fontWeight: 700, color, flexShrink: 0,
      }}>
        {icon}
      </div>

      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: "0.68rem", color: "#E6EDF3", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name}
        </div>
        {dir && (
          <div style={{ fontSize: "0.58rem", color: "#8B949E", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {dir}
          </div>
        )}
        <div style={{ fontSize: "0.58rem", color: "#8B949E" }}>{fmtSize(d.sizeBytes)}</div>
      </div>

      <Handle type="target" position={Position.Left} style={{ background: color, width: 6, height: 6, border: "none" }} />
    </div>
  );
});
