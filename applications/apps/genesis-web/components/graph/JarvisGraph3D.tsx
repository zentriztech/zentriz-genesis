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

import { useEffect, useMemo, useRef } from "react";
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

export function JarvisGraph3D({ nodes, links, width, height, activeAgent, onNodeClick }: Props) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dataRef = useRef<{ sig: string; data: { nodes: any[]; links: Array<{ source: string; target: string; color: string; kind?: string }> } }>({
    sig: "", data: { nodes: [], links: [] },
  });
  const didFitRef = useRef(false);
  const lastFitCountRef = useRef(0);

  // graphData ESTÁVEL: só gera novo objeto (nova identidade → re-ingest) quando o CONJUNTO
  // visível muda de fato (mesma disciplina do 2D → sem reheat storm). Na regeneração,
  // PRESERVA as posições (x/y/z/velocidades) dos nós que já existiam — o react-force-graph
  // muta esses campos in-place nos MESMOS objetos que guardamos em dataRef, então copiamos
  // por id p/ os novos nós. Sem isto, cada link novo (agentes conversando ↑ links.length)
  // regenerava nós sem posição → d3-force-3d re-randomizava a esfera inteira a cada tick.
  // Nós NOVOS entram sem posição (a física os acomoda) e disparam re-enquadramento.
  const graphData = useMemo(() => {
    const sig = nodes.map(n => `${n.id}:${n.detail ?? ""}:${n.color}`).sort().join("|") + "§" + links.length;
    if (sig === dataRef.current.sig) return dataRef.current.data;
    const prevPos = new Map<string, Record<string, number>>();
    for (const pn of dataRef.current.data.nodes) {
      if (pn && pn.id != null && Number.isFinite(pn.x)) {
        prevPos.set(pn.id, { x: pn.x, y: pn.y, z: pn.z, vx: pn.vx, vy: pn.vy, vz: pn.vz });
      }
    }
    const data = {
      nodes: nodes.map(n => ({ id: n.id, label: n.label, type: n.type, role: n.role, color: n.color, size: n.size, detail: n.detail, ...(prevPos.get(n.id) ?? {}) })),
      links: links.map(l => ({ source: idOf(l.source), target: idOf(l.target), color: l.color, kind: l.kind })),
    };
    dataRef.current = { sig, data };
    return data;
  }, [nodes, links]);

  // Configura bloom + órbita automática assim que a instância do grafo existe (o import
  // dinâmico pode montar depois do 1º render → poll curto até fgRef estar pronto).
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const setup = async () => {
      const fg = fgRef.current;
      if (!fg) { if (tries++ < 30 && !cancelled) timer = setTimeout(setup, 80); return; }
      try {
        const THREE = await import("three");
        const { UnrealBloomPass } = await import("three/examples/jsm/postprocessing/UnrealBloomPass.js");
        if (cancelled || !fgRef.current) return;
        const composer = fgRef.current.postProcessingComposer?.();
        if (composer) {
          const bloom = new UnrealBloomPass(new THREE.Vector2(width || 800, height || 600), 2.1, 0.9, 0.05);
          composer.addPass(bloom);
        }
      } catch { /* bloom é enfeite: se o addon não resolver, o grafo 3D ainda funciona */ }
      // Órbita lenta (controles orbit) → sensação de HUD cinematográfico do JARVIS.
      try {
        const controls = fgRef.current?.controls?.();
        if (controls) { controls.autoRotate = true; controls.autoRotateSpeed = 0.55; }
      } catch { /* controles podem não expor autoRotate */ }
    };
    setup();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  // roda 1× por montagem do modelo JARVIS
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ForceGraph3D
      ref={fgRef}
      graphData={graphData}
      width={width || 800}
      height={height || 600}
      backgroundColor="#01030A"
      showNavInfo={false}
      controlType="orbit"
      // Nós: esferas emissivas — com o bloom viram pontos de luz "vivos". Os acessores do
      // react-force-graph-3d recebem NodeObject/LinkObject (tipos frouxos da lib); fazemos
      // o cast p/ o nosso shape concreto dentro (mesmo padrão do grafo 2D).
      nodeColor={(n: object) => (n as Jarvis3DNode).color}
      nodeVal={(n: object) => {
        const node = n as Jarvis3DNode;
        const base = node.size ?? 4;
        return baseRoleMatches(node, activeAgent) ? base * 2.2 : base; // agente ativo pulsa maior
      }}
      nodeOpacity={0.95}
      nodeResolution={16}
      nodeLabel={(n: object) => { const node = n as Jarvis3DNode; return `${node.label}${node.detail ? " — " + node.detail : ""}`; }}
      // Arestas discretas + partículas de dados fluindo (o "cérebro conversando" em 3D).
      linkColor={(l: object) => (l as { color: string }).color}
      linkOpacity={0.28}
      linkWidth={0.5}
      linkDirectionalParticles={2}
      linkDirectionalParticleWidth={1.6}
      linkDirectionalParticleSpeed={0.006}
      linkDirectionalParticleColor={(l: object) => (l as { color: string }).color}
      onEngineStop={() => {
        // Reenquadra quando o layout 3D assenta: no 1º povoamento e sempre que a contagem
        // de nós CRESCE (novos nós podem cair fora do frame). Como as posições dos nós
        // existentes são preservadas, mudanças só de links NÃO mexem na contagem → sem
        // re-fit espúrio brigando com a órbita automática.
        const n = graphData.nodes.length;
        if ((!didFitRef.current || n !== lastFitCountRef.current) && fgRef.current) {
          try { fgRef.current.zoomToFit?.(800, 60); didFitRef.current = true; lastFitCountRef.current = n; } catch { /* noop */ }
        }
      }}
      onNodeClick={(n: object) => { const node = n as Jarvis3DNode; onNodeClick?.(node.id, node.type); }}
    />
  );
}

// Um nó de agente "casa" com o agente ativo quando sua role bate com a chave ativa.
function baseRoleMatches(n: Jarvis3DNode, activeAgent?: string | null): boolean {
  if (!activeAgent || n.type !== "agent") return false;
  return (n.role ?? "") === activeAgent;
}
