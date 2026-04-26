"use client";

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { DocNodeData } from "@/lib/useGraphData";
import { getAgentProfile } from "@/lib/agentProfiles";

const PHASE_COLOR: Record<string, string> = {
  spec:     "#8B949E",
  cto:      "#1976d2",
  engineer: "#2e7d32",
  pm:       "#ed6c02",
  qa:       "#43a047",
  devops:   "#0d47a1",
  other:    "#484F58",
};

const PHASE_ICON: Record<string, string> = {
  spec: "📄", cto: "🎯", engineer: "⚙️",
  pm: "📋", qa: "✅", devops: "🐳", other: "📁",
};

function fmtDate(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

export const DocNode = memo(function DocNode({ data }: NodeProps) {
  const d = data as DocNodeData;
  const color = PHASE_COLOR[d.phase] ?? "#484F58";
  const icon  = PHASE_ICON[d.phase] ?? "📁";
  const profile = getAgentProfile(d.creator);

  // Short filename — strip leading path and truncate
  const shortName = d.filename.split("/").pop() ?? d.filename;
  const displayName = shortName.length > 30 ? shortName.slice(0, 28) + "…" : shortName;
  const titleShort  = (d.title ?? "").length > 40 ? d.title.slice(0, 38) + "…" : d.title;

  return (
    <div
      style={{
        background: "#161B22",
        border: `1px solid ${color}40`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 6,
        padding: "6px 10px",
        minWidth: 200, maxWidth: 240,
        cursor: "default",
      }}
    >
      {/* Phase icon + title */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
        <span style={{ fontSize: "0.8rem", flexShrink: 0 }}>{icon}</span>
        <div style={{
          fontSize: "0.7rem", fontWeight: 600, color: "#E6EDF3",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {titleShort || displayName}
        </div>
      </div>

      {/* Filename */}
      <div style={{
        fontSize: "0.6rem", color: "#8B949E", fontFamily: "monospace",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        marginBottom: 3,
      }}>
        {displayName}
      </div>

      {/* Creator + date row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          background: `${profile.color}18`, border: `1px solid ${profile.color}30`,
          borderRadius: 10, padding: "1px 6px",
        }}>
          <span style={{ fontSize: "0.65rem" }}>{profile.avatar}</span>
          <span style={{ fontSize: "0.6rem", color: profile.color, fontWeight: 600 }}>{profile.name}</span>
        </div>
        {d.createdAt && (
          <span style={{ fontSize: "0.58rem", color: "#484F58", flexShrink: 0 }}>
            {fmtDate(d.createdAt)}
          </span>
        )}
      </div>

      <Handle type="target" position={Position.Left}  style={{ background: color, width: 6, height: 6, border: "none" }} />
      <Handle type="source" position={Position.Right} style={{ background: color, width: 6, height: 6, border: "none" }} />
    </div>
  );
});
