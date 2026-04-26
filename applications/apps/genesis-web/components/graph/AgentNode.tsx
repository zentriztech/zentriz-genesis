"use client";

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { AgentNodeData } from "@/lib/useGraphData";

export const AgentNode = memo(function AgentNode({ data }: NodeProps) {
  const d = data as AgentNodeData;
  return (
    <div
      style={{
        display: "flex", flexDirection: "column", alignItems: "center",
        gap: 4, minWidth: 80, cursor: "default",
      }}
    >
      {/* Avatar circle */}
      <div
        style={{
          width: 48, height: 48, borderRadius: "50%",
          background: `${d.color}22`,
          border: `2px solid ${d.isActive ? d.color : d.color + "60"}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "1.3rem",
          boxShadow: d.isActive ? `0 0 0 4px ${d.color}30, 0 0 12px ${d.color}40` : "none",
          animation: d.isActive ? "agentPulse 1.6s ease-in-out infinite" : "none",
        }}
      >
        {d.avatar}
      </div>

      {/* Name */}
      <div style={{ fontSize: "0.7rem", fontWeight: 600, color: d.color, textAlign: "center", maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {d.name}
      </div>

      {/* Last message snippet */}
      {d.lastMessage && (
        <div style={{
          fontSize: "0.6rem", color: "#8B949E", maxWidth: 90, textAlign: "center",
          overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
          lineHeight: 1.3,
        }}>
          {d.lastMessage}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} style={{ background: d.color, width: 8, height: 8, border: "none" }} />
      <Handle type="target" position={Position.Top}    style={{ background: d.color, width: 8, height: 8, border: "none" }} />

      <style>{`
        @keyframes agentPulse {
          0%,100% { box-shadow: 0 0 0 4px ${d.color}30, 0 0 12px ${d.color}40; }
          50%      { box-shadow: 0 0 0 8px ${d.color}15, 0 0 20px ${d.color}60; }
        }
      `}</style>
    </div>
  );
});
