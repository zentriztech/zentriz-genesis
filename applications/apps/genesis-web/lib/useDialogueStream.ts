"use client";

/**
 * useDialogueStream — "sistema nervoso" do Living Team Mesh.
 *
 * Carrega o histórico do diálogo via GET normal e depois abre um stream SSE ao vivo
 * (`/api/projects/:id/dialogue/stream`) lido por fetch + ReadableStream — e NÃO por
 * `EventSource`, que não consegue enviar o header Authorization (o token nunca vai na URL
 * nem em log). Se o streaming não estiver disponível (ambiente sem ReadableStream, proxy que
 * bufferiza, erro repetido), cai para polling do GET normal — nenhum consumidor fica sem dados.
 *
 * `onEvent` é chamado UMA vez por evento NOVO ao vivo (nunca para o backlog histórico), para o
 * grafo disparar o "pacote" de mensagem na aresta certa no instante em que o evento acontece.
 */

import { useEffect, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import type { DialogueEntry } from "@/components/LiveDialogue";

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

function authHeader(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("genesis_token") : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface UseDialogueStreamOptions {
  projectId: string;
  /** Liga o stream/polling. Default true. */
  enabled?: boolean;
  /** Chamado 1x por evento NOVO ao vivo (não para o histórico inicial). */
  onEvent?: (entry: DialogueEntry) => void;
  /** Intervalo do fallback de polling (ms). Default 6000. */
  pollIntervalMs?: number;
}

export interface UseDialogueStreamResult {
  entries: DialogueEntry[];
  /** true enquanto o stream SSE está recebendo (não no modo polling). */
  connected: boolean;
}

/** Teto de entradas mantidas em memória — o grafo só precisa da cauda recente para nós/arestas
 * ativos; sem teto, cada evento ao vivo re-percorreria uma lista que cresce sem limite. */
const MAX_ENTRIES = 2000;
/** Sem bytes por este tempo → o transporte não está fluindo (proxy que bufferiza SSE): aborta e
 * conta como falha. Maior que o heartbeat do servidor (15s) para não abortar conexão saudável. */
const IDLE_ABORT_MS = 25000;
/** Teto duro de reconexões: um servidor que aceita e encerra na hora não pode reconectar para
 * sempre — após este limite, degrada para polling em definitivo. */
const MAX_STREAM_CONNECTS = 8;

export function useDialogueStream({
  projectId,
  enabled = true,
  onEvent,
  pollIntervalMs = 6000,
}: UseDialogueStreamOptions): UseDialogueStreamResult {
  const [entries, setEntries] = useState<DialogueEntry[]>([]);
  const [connected, setConnected] = useState(false);
  // Callback sempre atual sem re-abrir o stream a cada render.
  const onEventRef = useRef<typeof onEvent>(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!enabled || !projectId) return;

    let cancelled = false;
    const seen = new Set<string>();
    let cursor: string | undefined; // ISO createdAt do último evento visto
    // Piso temporal capturado ANTES do GET de histórico: se o histórico vier vazio, o stream começa
    // daqui (e não do "agora" do servidor), fechando a janela entre o GET e a abertura do stream.
    const bootFloor = new Date().toISOString();
    let historyOk = false; // o GET de histórico REALMENTE populou o `seen`?
    let polling = false; // já degradou para polling em definitivo?
    let controller: AbortController | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let streamFailures = 0;
    let streamConnects = 0;

    // Aplica uma lista de entradas: dedup por id, ordena por createdAt, dispara onEvent só ao vivo.
    const ingest = (incoming: DialogueEntry[], live: boolean) => {
      const fresh: DialogueEntry[] = [];
      for (const e of incoming) {
        if (!e || !e.id || seen.has(e.id)) continue;
        seen.add(e.id);
        fresh.push(e);
        if (e.createdAt && (!cursor || e.createdAt > cursor)) cursor = e.createdAt;
      }
      if (fresh.length === 0) return;
      if (seen.size > 8000) seen.clear(); // teto de memória (cursor já avançou)
      setEntries((prev) => {
        const merged = [...prev, ...fresh];
        merged.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
        // Teto duro: mantém só a cauda recente para o rebuild do grafo não virar O(n) crescente.
        return merged.length > MAX_ENTRIES ? merged.slice(merged.length - MAX_ENTRIES) : merged;
      });
      if (live) for (const e of fresh) onEventRef.current?.(e);
    };

    // ── Fallback: polling do GET normal (diff por id). ──
    // Se o histórico inicial FALHOU (`historyOk === false`), o `seen` está vazio: a primeira
    // passada do polling traria o backlog inteiro como se fosse novo. Por isso a 1ª passada é
    // ingerida como histórico (live=false) e só as seguintes disparam onEvent.
    const startPolling = () => {
      if (pollTimer || polling) return;
      polling = true;
      let firstPoll = true;
      const tick = async () => {
        try {
          const data = await apiGet<DialogueEntry[]>(`/api/projects/${projectId}/dialogue`);
          if (cancelled) return;
          const live = historyOk ? true : !firstPoll;
          ingest(Array.isArray(data) ? data : [], live);
          firstPoll = false;
        } catch {
          /* transitório — próxima passada tenta de novo */
        }
      };
      void tick();
      pollTimer = setInterval(() => void tick(), pollIntervalMs);
    };

    // ── Stream SSE via fetch + ReadableStream ──
    const openStream = async () => {
      if (cancelled || polling) return;
      // Piso: cursor do último visto, senão o instante capturado ANTES do GET de histórico —
      // nunca `undefined` (que faria o servidor começar do "agora" e perder eventos da janela).
      const since = cursor ?? bootFloor;
      const qs = `?since=${encodeURIComponent(since)}`;
      streamConnects += 1;
      const openedAt = Date.now(); // p/ distinguir conexão saudável de loop "aceita-e-encerra"
      controller = new AbortController();
      const localController = controller;
      let gotBytes = false; // este socket entregou ALGUM byte? (prova que o transporte flui)
      // Watchdog de inatividade: se nenhum byte chegar em IDLE_ABORT_MS, o transporte não está
      // passando (proxy que bufferiza SSE) — aborta para cair no finally e contar como falha.
      let idle: ReturnType<typeof setTimeout> | null = null;
      const armIdle = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => localController.abort(), IDLE_ABORT_MS);
      };
      try {
        const res = await fetch(`${BASE}/api/projects/${projectId}/dialogue/stream${qs}`, {
          method: "GET",
          headers: { ...authHeader(), Accept: "text/event-stream" },
          credentials: "include",
          signal: localController.signal,
          cache: "no-store",
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        setConnected(true);
        armIdle();

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done || cancelled) break;
          if (value && value.length) {
            if (!gotBytes) {
              // Primeiro byte real deste socket: o transporte comprovadamente flui → zera falhas.
              gotBytes = true;
              streamFailures = 0;
            }
            armIdle(); // rearma o watchdog a cada chunk (inclui heartbeats ": hb")
          }
          buffer += decoder.decode(value, { stream: true });
          // Frames SSE são separados por linha em branco.
          let sep = buffer.indexOf("\n\n");
          while (sep !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            handleFrame(frame);
            sep = buffer.indexOf("\n\n");
          }
        }
      } catch {
        /* erro/abort — cai no finally que decide reconectar ou fazer polling */
      } finally {
        if (idle) clearTimeout(idle);
        setConnected(false);
        // Uma conexão que sobreviveu além de um heartbeat (>20s) é comprovadamente saudável — não
        // é o loop "aceita-e-encerra" (esse morre em ms). Zera o orçamento de reconexões para que
        // blips normais numa sessão longa (wifi handoff, sleep/wake, reciclo de LB) NÃO degradem
        // o stream para polling em definitivo. Curtas (<20s) não zeram → o teto ainda contém o loop.
        // NB: não dá para zerar "ao primeiro byte" — o servidor emite ": connected" na hora, então
        // o próprio loop aceita-e-encerra entrega 1 byte; só o TEMPO DE VIDA distingue os dois.
        if (Date.now() - openedAt > 20000) {
          streamConnects = 0;
          streamFailures = 0;
        }
        if (!cancelled && !polling) {
          streamFailures += 1;
          // Degrada para polling se: (a) falhas de transporte repetidas (proxy não passa SSE) ou
          // (b) teto duro de reconexões batido (servidor aceita-e-encerra em loop). Senão reconecta.
          if (streamFailures >= 3 || streamConnects >= MAX_STREAM_CONNECTS) {
            startPolling();
          } else {
            const backoff = Math.min(15000, 1000 * 2 ** (streamFailures - 1));
            reconnectTimer = setTimeout(() => void openStream(), backoff);
          }
        }
      }
    };

    const handleFrame = (frame: string) => {
      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue; // comentário/heartbeat
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (eventName !== "dialogue" || dataLines.length === 0) return;
      try {
        const parsed = JSON.parse(dataLines.join("\n")) as DialogueEntry;
        ingest([parsed], true);
      } catch {
        /* frame malformado — ignora */
      }
    };

    // ── Boot: histórico primeiro, depois stream ──
    (async () => {
      try {
        const data = await apiGet<DialogueEntry[]>(`/api/projects/${projectId}/dialogue`);
        if (cancelled) return;
        ingest(Array.isArray(data) ? data : [], false); // histórico NÃO dispara onEvent
        historyOk = true; // só marca sucesso se REALMENTE populou o `seen`
      } catch {
        /* histórico falhou (`historyOk` fica false) — o fallback trata a 1ª passada como histórico */
      }
      if (cancelled) return;
      if (typeof ReadableStream === "undefined" || typeof fetch === "undefined") {
        startPolling();
      } else {
        void openStream();
      }
    })();

    return () => {
      cancelled = true;
      controller?.abort();
      if (pollTimer) clearInterval(pollTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
    // Reabrir só quando o projeto ou o enable mudam (não a cada render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, enabled, pollIntervalMs]);

  return { entries, connected };
}
