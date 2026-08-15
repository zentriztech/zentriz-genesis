"use client";

// ── Modelo JARVIS 3D ────────────────────────────────────────────────────────────
// Renderizador 3D real (WebGL/Three.js) via react-force-graph-3d — MESMA API de
// dados {nodes,links} do grafo 2D, então recebe o graphData VIVO já construído pelo
// ForceGraph (roster + tasks/docs + streams) sem duplicar pipeline. Visual "JARVIS":
// esfera de nós flutuando no espaço, brilho aditivo (UnrealBloomPass), partículas de
// dados percorrendo as arestas e câmera em órbita lenta e cinematográfica.
//
// É ADITIVO: um 8º modelo ao lado dos 7 modelos 2D — não remove nada. Três.js só é
// baixado quando este componente monta (import dinâmico ssr:false), então os modelos
// 2D não pagam o custo do bundle.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";

// react-force-graph-3d puxa three.js — só no cliente.
const ForceGraph3D = dynamic(() => import("react-force-graph-3d"), { ssr: false });

export interface Jarvis3DNode {
  id: string; label: string; type: string; role?: string;
  color: string; size: number; detail?: string;
}
export interface Jarvis3DLink {
  source: string | { id: string }; target: string | { id: string };
  color: string; kind?: string;
}

interface Props {
  nodes: Jarvis3DNode[];
  links: Jarvis3DLink[];
  width: number;
  height: number;
  activeAgent?: string | null;
  onNodeClick?: (id: string, type: string) => void;
}

const idOf = (x: string | { id: string }) => (typeof x === "object" ? x.id : x);

// Ícone por tipo de nó (fallback quando não é agente — agentes usam o avatar em node.detail).
const TYPE_ICON: Record<string, string> = { agent: "◈", task: "⚙", doc: "▤", artifact: "◆" };

// "ROLE·Nome" → { role, name }. Sem separador, tudo vira nome.
function splitLabel(label: string): { role: string; name: string } {
  const i = label.indexOf("·");
  if (i < 0) return { role: "", name: label };
  return { role: label.slice(0, i), name: label.slice(i + 1) };
}

// Hash determinístico do id → fase de respiração (dessincroniza o pulso dos halos).
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function JarvisGraph3D({ nodes, links, width, height, activeAgent, onNodeClick }: Props) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);

  // three.js só existe no cliente. Montamos o ForceGraph3D apenas DEPOIS que THREE resolve —
  // assim nodeThreeObject nunca roda sem THREE, e usamos a MESMA cópia única (hoisteada) que o
  // renderizador usa por dentro (evita o crash "Multiple instances of Three.js").
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [three, setThree] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    import("three").then((T) => { if (alive) setThree(T); }).catch(() => { /* sem 3D */ });
    return () => { alive = false; };
  }, []);

  // agente ativo por REF → o pulso do agente ativo (onBeforeRender) reage SEM reconstruir os
  // objetos 3D nem re-simular a física (trocar o ativo não recria sprites).
  const activeRef = useRef<string | null | undefined>(activeAgent);
  useEffect(() => { activeRef.current = activeAgent; }, [activeAgent]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dataRef = useRef<{ sig: string; nodeSig: string; data: { nodes: any[]; links: Array<{ source: string; target: string; color: string; kind?: string }> } }>({
    sig: "", nodeSig: "", data: { nodes: [], links: [] },
  });
  const didFitRef = useRef(false);
  const lastFitCountRef = useRef(0);

  // Caches de recursos GPU (persistem entre rebuilds → não recriamos canvas/geometria a cada
  // mudança do conjunto de nós). Texturas/geometrias/materiais descartados no unmount.
  const gpu = useRef({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    glow: new Map<string, any>(), ring: new Map<string, any>(), glyph: new Map<string, any>(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    label: new Map<string, any>(), geo: new Map<string, any>(), smat: new Map<string, any>(),
  });
  // starfield + névoa injetados na cena — guardados p/ dispose.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sceneFxRef = useRef<any>(null);
  // pass de bloom — guardado p/ acompanhar o resize do container (resolução do bloom).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bloomRef = useRef<any>(null);

  // graphData ESTÁVEL: só gera novo objeto (nova identidade → re-ingest) quando o CONJUNTO
  // visível muda de fato (mesma disciplina do 2D → sem reheat storm).
  //  • Quando MUDAM SÓ AS ARESTAS (agentes conversando ↑ links.length, set de nós idêntico):
  //    REUTILIZA os MESMOS objetos de nó — o react-force-graph mantém o __threeObj deles,
  //    então NENHUM Sprite/Mesh/halo é destruído e recriado a cada tick, e as posições vivas
  //    (mutadas in-place pela física) seguem intactas. Só o array de links é reconstruído.
  //  • Quando o set de nós muda: reconstrói os nós PRESERVANDO por id as posições
  //    (x/y/z/velocidades) dos que já existiam; nós novos entram sem posição (a física os
  //    acomoda) e disparam re-enquadramento no onEngineStop.
  const graphData = useMemo(() => {
    const nodeSig = nodes.map(n => `${n.id}:${n.detail ?? ""}:${n.color}`).sort().join("|");
    const sig = nodeSig + "§" + links.length;
    if (sig === dataRef.current.sig) return dataRef.current.data;

    const nodeSetChanged = nodeSig !== dataRef.current.nodeSig;
    let nextNodes: typeof dataRef.current.data.nodes;
    if (!nodeSetChanged && dataRef.current.data.nodes.length) {
      // Set de nós idêntico → reaproveita as MESMAS instâncias (mantém 3D object + posições).
      nextNodes = dataRef.current.data.nodes;
    } else {
      const prevPos = new Map<string, Record<string, number>>();
      for (const pn of dataRef.current.data.nodes) {
        if (pn && pn.id != null && Number.isFinite(pn.x)) {
          prevPos.set(pn.id, { x: pn.x, y: pn.y, z: pn.z, vx: pn.vx, vy: pn.vy, vz: pn.vz });
        }
      }
      nextNodes = nodes.map(n => ({ id: n.id, label: n.label, type: n.type, role: n.role, color: n.color, size: n.size, detail: n.detail, ...(prevPos.get(n.id) ?? {}) }));
    }
    const data = {
      nodes: nextNodes,
      links: links.map(l => ({ source: idOf(l.source), target: idOf(l.target), color: l.color, kind: l.kind })),
    };
    dataRef.current = { sig, nodeSig, data };
    return data;
  }, [nodes, links]);

  // ── Fábricas de textura (memoizadas em `three`, usando os caches por ref) ──────────
  const tex = useMemo(() => {
    if (!three) return null;
    const T = three;
    const C = gpu.current;
    const hex6 = (c: string) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c : "#7C8698"); // alfa-hex seguro
    const glow = (color: string) => {
      const k = hex6(color); const hit = C.glow.get(k); if (hit) return hit;
      const s = 256; const cv = document.createElement("canvas"); cv.width = cv.height = s;
      const ctx = cv.getContext("2d")!; const c = s / 2;
      const g = ctx.createRadialGradient(c, c, 0, c, c, c);
      g.addColorStop(0, k + "FF"); g.addColorStop(0.16, k + "DD");
      g.addColorStop(0.42, k + "55"); g.addColorStop(1, k + "00");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c, c, c, 0, Math.PI * 2); ctx.fill();
      const t = new T.CanvasTexture(cv); t.needsUpdate = true; C.glow.set(k, t); return t;
    };
    const ring = (color: string) => {
      const k = hex6(color); const hit = C.ring.get(k); if (hit) return hit;
      const s = 256; const cv = document.createElement("canvas"); cv.width = cv.height = s;
      const ctx = cv.getContext("2d")!; const c = s / 2;
      ctx.strokeStyle = k; ctx.shadowColor = k; ctx.shadowBlur = 16;
      ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(c, c, c * 0.76, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 0.45; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(c, c, c * 0.9, 0, Math.PI * 2); ctx.stroke();
      const t = new T.CanvasTexture(cv); t.needsUpdate = true; C.ring.set(k, t); return t;
    };
    const glyph = (ch: string) => {
      const hit = C.glyph.get(ch); if (hit) return hit;
      const s = 256; const cv = document.createElement("canvas"); cv.width = cv.height = s;
      const ctx = cv.getContext("2d")!;
      ctx.font = `${Math.floor(s * 0.58)}px "Segoe UI Symbol","Apple Color Emoji","Noto Color Emoji",system-ui,sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#FFFFFF"; ctx.shadowColor = "#FFFFFF"; ctx.shadowBlur = s * 0.05;
      ctx.fillText(ch, s / 2, s / 2 + s * 0.02);
      const t = new T.CanvasTexture(cv); t.needsUpdate = true; C.glyph.set(ch, t); return t;
    };
    const label = (name: string, role: string, color: string) => {
      const key = `${role}|${name}|${color}`; const hit = C.label.get(key); if (hit) return hit;
      const w = 512, h = 176; const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d")!;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = "700 60px system-ui,'Segoe UI',sans-serif";
      ctx.fillStyle = "#EAF2FF"; ctx.shadowColor = "#000000"; ctx.shadowBlur = 10;
      ctx.fillText(name, w / 2, role ? h * 0.38 : h * 0.5);
      if (role) {
        ctx.font = "700 34px system-ui,'Segoe UI',sans-serif";
        ctx.fillStyle = hex6(color); ctx.shadowColor = hex6(color); ctx.shadowBlur = 12;
        ctx.fillText(role.toUpperCase(), w / 2, h * 0.74);
      }
      const t = new T.CanvasTexture(cv); t.needsUpdate = true; C.label.set(key, t); return t;
    };
    return { glow, ring, glyph, label };
  }, [three]);

  // ── Objeto 3D por nó ───────────────────────────────────────────────────────────
  // Agentes = MARCADORES PRINCIPAIS: esfera luminosa + halo pulsante + anel orbital + ícone
  // (avatar) + rótulo com nome/role. Tasks/docs/artefatos entram menores, com o ícone do tipo.
  // Cada "bolinha" é um agente/artefato VIVO — o cérebro de IA conversando em 3D.
  const nodeObject = useCallback((n: object) => {
    const T = three; if (!T || !tex) return undefined;
    const C = gpu.current;
    const node = n as Jarvis3DNode;
    const color = /^#[0-9a-fA-F]{6}$/.test(node.color) ? node.color : "#7C8698";
    const isAgent = node.type === "agent";
    const isCore = node.role === "system";
    const baseR = Math.max(2, node.size ?? 4);
    const group = new T.Group();

    // Esfera-núcleo (MeshBasic → cor plena; "acende" sob o bloom). Geometria/material em cache.
    const rSphere = +(baseR * (isAgent ? 0.55 : 0.46)).toFixed(2);
    const seg = isAgent ? 28 : 14;
    const gk = `${rSphere}:${seg}`;
    let geo = C.geo.get(gk);
    if (!geo) { geo = new T.SphereGeometry(rSphere, seg, seg); C.geo.set(gk, geo); }
    const mk = `${color}:${isAgent ? "a" : "s"}`;
    let smat = C.smat.get(mk);
    if (!smat) { smat = new T.MeshBasicMaterial({ color, transparent: true, opacity: isAgent ? 0.98 : 0.82 }); C.smat.set(mk, smat); }
    const sphere = new T.Mesh(geo, smat);
    group.add(sphere);

    // Halo radial aditivo (respira; intensifica no agente ativo). frustumCulled off → anima sempre.
    const glow = new T.Sprite(new T.SpriteMaterial({ map: tex.glow(color), transparent: true, blending: T.AdditiveBlending, depthWrite: false, depthTest: false }));
    const glowBase = baseR * (isCore ? 5.6 : isAgent ? 4.0 : 2.2);
    glow.scale.set(glowBase, glowBase, 1); glow.renderOrder = 1; glow.frustumCulled = false;
    glow.raycast = () => {}; // decoração não captura clique/hover → só a esfera (e o ícone) são alvos
    const glowOpBase = isAgent ? 0.95 : 0.5;
    group.add(glow);

    // Ícone (avatar do agente OU ícone do tipo) — sempre virado à câmera e por cima da esfera.
    const icon = isAgent ? (node.detail || TYPE_ICON.agent) : (TYPE_ICON[node.type] || "•");
    const glyph = new T.Sprite(new T.SpriteMaterial({ map: tex.glyph(icon), transparent: true, depthWrite: false, depthTest: false }));
    const gs = baseR * (isAgent ? 1.35 : 0.95);
    glyph.scale.set(gs, gs, 1); glyph.renderOrder = 12;
    group.add(glyph);

    if (isAgent) {
      // Anel orbital — reforça o agente como marcador principal.
      const ring = new T.Sprite(new T.SpriteMaterial({ map: tex.ring(color), transparent: true, blending: T.AdditiveBlending, depthWrite: false, depthTest: false, opacity: 0.85 }));
      const rs = baseR * (isCore ? 3.4 : 2.7);
      ring.scale.set(rs, rs, 1); ring.renderOrder = 2; ring.raycast = () => {};
      group.add(ring);
      // Rótulo: nome (claro, bold) + role (na cor do agente).
      const { role, name } = splitLabel(node.label);
      const lab = new T.Sprite(new T.SpriteMaterial({ map: tex.label(name, role, color), transparent: true, depthWrite: false, depthTest: false }));
      const lw = baseR * 3.8; lab.scale.set(lw, lw * (176 / 512), 1);
      lab.position.set(0, -(baseR * 1.7), 0); lab.renderOrder = 13; lab.raycast = () => {};
      group.add(lab);
    }

    // Vida: respiração do halo + destaque do agente ativo (lido por ref → sem rebuild/reheat).
    const phase = (hashStr(node.id) % 628) / 100;
    glow.onBeforeRender = () => {
      const t = performance.now() / 1000;
      const active = isAgent && !!activeRef.current && node.role === activeRef.current;
      const breathe = 1 + 0.09 * Math.sin(t * 1.6 + phase);
      const sc = glowBase * breathe * (active ? 1.7 : 1);
      glow.scale.set(sc, sc, 1);
      glow.material.opacity = glowOpBase * (0.85 + 0.15 * Math.sin(t * 2 + phase)) * (active ? 1.15 : 1);
      sphere.scale.setScalar(active ? 1.35 : 1);
    };
    return group;
  }, [three, tex]);

  // ── Bloom + órbita + campo de estrelas + névoa (profundidade "espaço profundo") ────
  // O import dinâmico pode montar depois do 1º render → poll curto até fgRef estar pronto.
  useEffect(() => {
    if (!three) return;
    const T = three;
    let cancelled = false; let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const setup = async () => {
      const fg = fgRef.current;
      if (!fg) { if (tries++ < 40 && !cancelled) timer = setTimeout(setup, 80); return; }
      // Bloom — o brilho aditivo que faz os nós "acenderem".
      try {
        const { UnrealBloomPass } = await import("three/examples/jsm/postprocessing/UnrealBloomPass.js");
        if (cancelled || !fgRef.current) return;
        const composer = fgRef.current.postProcessingComposer?.();
        if (composer) {
          const bloom = new UnrealBloomPass(new T.Vector2(width || 800, height || 600), 1.6, 0.8, 0.12);
          composer.addPass(bloom);
          bloomRef.current = bloom;
        }
      } catch { /* bloom é enfeite: se o addon não resolver, o 3D ainda funciona */ }
      // Órbita cinematográfica lenta.
      try {
        const controls = fgRef.current?.controls?.();
        if (controls) { controls.autoRotate = true; controls.autoRotateSpeed = 0.5; }
      } catch { /* controles podem não expor autoRotate */ }
      // Campo de estrelas + névoa → profundidade e sensação de espaço profundo.
      try {
        const scene = fgRef.current?.scene?.();
        if (scene && !sceneFxRef.current) {
          const N = 1500; const pos = new Float32Array(N * 3);
          // Distribuição determinística (latitude uniforme + ângulo áureo) — sem Math.random.
          for (let i = 0; i < N; i++) {
            const y = (i / (N - 1)) * 2 - 1;
            const rp = Math.sqrt(Math.max(0, 1 - y * y));
            const a = i * 2.399963;
            const r = 620 + ((i * 61) % 1000);
            pos[i * 3] = Math.cos(a) * rp * r;
            pos[i * 3 + 1] = y * r;
            pos[i * 3 + 2] = Math.sin(a) * rp * r;
          }
          const geo = new T.BufferGeometry();
          geo.setAttribute("position", new T.BufferAttribute(pos, 3));
          const mat = new T.PointsMaterial({ color: 0x9FC2FF, size: 2.1, sizeAttenuation: true, transparent: true, opacity: 0.6, depthWrite: false, blending: T.AdditiveBlending });
          const stars = new T.Points(geo, mat);
          stars.frustumCulled = false;
          scene.add(stars);
          scene.fog = new T.FogExp2(0x01030A, 0.00032);
          sceneFxRef.current = { scene, stars, geo, mat };
        }
      } catch { /* fx é enfeite */ }
    };
    setup();
    return () => {
      cancelled = true; if (timer) clearTimeout(timer);
      const fx = sceneFxRef.current;
      if (fx) {
        try { fx.scene.remove(fx.stars); fx.geo.dispose?.(); fx.mat.dispose?.(); fx.scene.fog = null; } catch { /* noop */ }
        sceneFxRef.current = null;
      }
      bloomRef.current = null;
    };
  // reinstala quando THREE resolve / no remount do modelo 3D
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [three]);

  // Bloom acompanha o resize do container (senão fica preso na resolução inicial).
  useEffect(() => {
    const b = bloomRef.current;
    if (b?.setSize) { try { b.setSize(width || 800, height || 600); } catch { /* noop */ } }
  }, [width, height]);

  // Descarte de recursos GPU no unmount (texturas/geometrias/materiais em cache).
  useEffect(() => {
    const C = gpu.current;
    return () => {
      [C.glow, C.ring, C.glyph, C.label, C.geo, C.smat].forEach((m) => {
        m.forEach((r) => { try { r.dispose?.(); } catch { /* noop */ } });
        m.clear();
      });
    };
  }, []);

  // Placeholder (mesmo fundo) enquanto THREE carrega — sem flash branco.
  if (!three) {
    return <div style={{ width: width || 800, height: height || 600, background: "#01030A", borderRadius: 8 }} />;
  }

  return (
    <ForceGraph3D
      ref={fgRef}
      graphData={graphData}
      width={width || 800}
      height={height || 600}
      backgroundColor="#01030A"
      showNavInfo={false}
      controlType="orbit"
      nodeRelSize={4}
      // Objeto 3D custom por nó (substitui a esfera padrão). Os acessores recebem tipos
      // frouxos da lib (NodeObject/LinkObject) → cast p/ nosso shape dentro.
      nodeThreeObject={nodeObject}
      nodeThreeObjectExtend={false}
      nodeLabel={(n: object) => { const node = n as Jarvis3DNode; return `${node.label}${node.detail ? " — " + node.detail : ""}`; }}
      // Arestas discretas + partículas de dados fluindo (o "cérebro conversando" em 3D).
      linkColor={(l: object) => (l as { color: string }).color}
      linkOpacity={0.2}
      linkWidth={0.7}
      linkDirectionalParticles={(l: object) => ((l as { kind?: string }).kind === "satellite" ? 1 : 4)}
      linkDirectionalParticleWidth={2.0}
      linkDirectionalParticleSpeed={0.009}
      linkDirectionalParticleColor={(l: object) => (l as { color: string }).color}
      onEngineStop={() => {
        // Reenquadra quando o layout 3D assenta: no 1º povoamento e sempre que a contagem
        // de nós CRESCE (novos nós podem cair fora do frame). Como as posições dos nós
        // existentes são preservadas, mudanças só de links NÃO mexem na contagem → sem
        // re-fit espúrio brigando com a órbita automática.
        const n = graphData.nodes.length;
        if ((!didFitRef.current || n !== lastFitCountRef.current) && fgRef.current) {
          try { fgRef.current.zoomToFit?.(800, 80); didFitRef.current = true; lastFitCountRef.current = n; } catch { /* noop */ }
        }
      }}
      onNodeClick={(n: object) => { const node = n as Jarvis3DNode; onNodeClick?.(node.id, node.type); }}
    />
  );
}
