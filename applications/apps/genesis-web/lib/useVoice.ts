"use client";

// ── Voz JARVIS — Web Speech API pura (ZERO dependência) ────────────────────────
// STT (reconhecimento) via SpeechRecognition/webkitSpeechRecognition; TTS (fala)
// via speechSynthesis. Ambos são APIs NATIVAS do navegador — nada é instalado.
// SSR-safe: todo acesso a `window` acontece dentro de efeitos/handlers (nunca no
// corpo de render), e `supported` é resolvido só no cliente (default false).

import { useCallback, useEffect, useRef, useState } from "react";

// Tipagem mínima local (a Web Speech API não faz parte do lib.dom padrão em todos
// os targets de TS) — evita `any` solto e mantém o strict feliz.
interface SpeechRecognitionAlternativeLike { transcript: string }
interface SpeechRecognitionResultLike { 0: SpeechRecognitionAlternativeLike; isFinal: boolean; length: number }
interface SpeechRecognitionEventLike { results: ArrayLike<SpeechRecognitionResultLike>; resultIndex: number }
interface SpeechRecognitionLike {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: SpeechRecognitionErrorLike) => void) | null;
}
interface SpeechRecognitionErrorLike { error?: string }
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface UseVoiceOptions {
  lang?: string;                         // idioma STT/TTS (default pt-BR)
  onCommand?: (transcript: string) => void; // chamado a cada frase FINAL reconhecida
}

export interface VoiceApi {
  sttSupported: boolean;   // reconhecimento de fala disponível?
  ttsSupported: boolean;   // síntese de fala disponível?
  listening: boolean;      // microfone ativo agora?
  toggleListening: () => void;
  speak: (text: string) => void;   // fala um texto (respeita mute)
  muted: boolean;          // TTS silenciado?
  toggleMuted: () => void;
}

export function useVoice({ lang = "pt-BR", onCommand }: UseVoiceOptions = {}): VoiceApi {
  const [sttSupported, setSttSupported] = useState(false);
  const [ttsSupported, setTtsSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [muted, setMuted] = useState(false);

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const cmdRef = useRef<UseVoiceOptions["onCommand"]>(onCommand);
  const wantListenRef = useRef(false); // p/ re-armar o STT (que para sozinho) enquanto o usuário quiser ouvir
  useEffect(() => { cmdRef.current = onCommand; }, [onCommand]);

  // Detecta suporte só no cliente.
  useEffect(() => {
    setSttSupported(!!getRecognitionCtor());
    setTtsSupported(typeof window !== "undefined" && "speechSynthesis" in window);
  }, []);

  // Instancia o reconhecedor 1× (quando suportado).
  useEffect(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const t = (r[0]?.transcript ?? "").trim();
          if (t) cmdRef.current?.(t);
        }
      }
    };
    // O STT do Chrome encerra sozinho após silêncio; se o usuário ainda quer ouvir,
    // re-arma. Caso contrário, marca como parado.
    rec.onend = () => {
      if (wantListenRef.current) { try { rec.start(); } catch { /* já rodando */ } }
      else setListening(false);
    };
    // Erros PERMANENTES (permissão negada / sem microfone / serviço proibido) NÃO podem
    // ser re-armados: o onend re-arma enquanto wantListenRef=true, então sem tratar isto
    // um "not-allowed" viraria start→onerror→onend→start… num loop apertado. Desliga o
    // desejo de ouvir e para. Erros transitórios (network/no-speech/aborted) caem no onend
    // e re-armam normalmente.
    rec.onerror = (e) => {
      const err = e?.error;
      if (err === "not-allowed" || err === "service-not-allowed" || err === "audio-capture") {
        wantListenRef.current = false;
        setListening(false);
      }
    };
    recRef.current = rec;
    return () => { wantListenRef.current = false; try { rec.abort(); } catch { /* noop */ } recRef.current = null; };
  }, [lang]);

  const toggleListening = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    if (wantListenRef.current) {
      wantListenRef.current = false;
      try { rec.stop(); } catch { /* noop */ }
      setListening(false);
    } else {
      wantListenRef.current = true;
      try { rec.start(); setListening(true); } catch { /* start duplo → ignora */ }
    }
  }, []);

  const speak = useCallback((text: string) => {
    if (muted || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang; u.rate = 1.02; u.pitch = 1.0;
      window.speechSynthesis.cancel(); // não empilha filas longas
      window.speechSynthesis.speak(u);
    } catch { /* síntese pode falhar sem voz instalada */ }
  }, [muted, lang]);

  const toggleMuted = useCallback(() => setMuted(m => !m), []);

  // Ao desmontar, garante que a síntese pare.
  useEffect(() => () => { try { window.speechSynthesis?.cancel(); } catch { /* noop */ } }, []);

  return { sttSupported, ttsSupported, listening, toggleListening, speak, muted, toggleMuted };
}
