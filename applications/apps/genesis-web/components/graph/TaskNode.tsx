"use client";

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { TaskNodeData } from "@/lib/useGraphData";

const STATUS_COLOR: Record<string, string> = {
  DONE:           "#10B981", QA_PASS:       "#10B981",
  IN_PROGRESS:    "#6366F1", WAITING_REVIEW:"#6366F1",
  QA_FAIL:        "#EF4444", BLOCKED:       "#EF4444",
  NEW:            "#8B949E", ASSIGNED:      "#F59E0B",
  CANCELLED:      "#6B7280",
};

const STATUS_LABEL: Record<string, string> = {
  DONE: "✓ Feito", QA_PASS: "✓ QA OK", IN_PROGRESS: "⟳ Dev",
  WAITING_REVIEW: "⟳ Review", QA_FAIL: "✗ QA Fail", BLOCKED: "⊘ Bloqueado",
  NEW: "◦ Nova", ASSIGNED: "→ Atribuída", CANCELLED: "— Cancelada",
};

export const TaskNode = memo(function TaskNode({ data }: NodeProps) {
  const d     = data as TaskNodeData;
  const color = STATUS_COLOR[d.status] ?? "#8B949E";
  const label = STATUS_LABEL[d.status] ?? d.status;

  return (
    <div
      onClick={() => d.onClickTask?.(d.taskId)}
      style={{
        background: "#161B22",
        border: `1px solid ${color}50`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 6,
        padding: "6px 10px",
        minWidth: 150, maxWidth: 170,
        cursor: d.onClickTask ? "pointer" : "default",
      }}
    >
      {/* Task ID */}
      <div style={{ fontSize: "0.65rem", fontFamily: "monospace", color: "#8B949E", marginBottom: 2 }}>
        {d.taskId}
      </div>

      {/* Requirements snippet */}
      <div style={{
        fontSize: "0.68rem", color: "#E6EDF3", lineHeight: 1.4,
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
        marginBottom: 4,
      }}>
        {d.requirements ?? d.taskId}
      </div>

      {/* Status pill */}
      <div style={{
        display: "inline-block", fontSize: "0.6rem", padding: "1px 6px",
        background: `${color}20`, color, borderRadius: 10, border: `1px solid ${color}40`,
      }}>
        {label}
      </div>

      <Handle type="target" position={Position.Top}    style={{ background: color, width: 6, height: 6, border: "none" }} />
      <Handle type="source" position={Position.Bottom} style={{ background: color, width: 6, height: 6, border: "none" }} />
    </div>
  );
});
