#!/usr/bin/env python3
"""Plano de evolução v2, tarefa 1.4 — cálculo da telemetria de desperdício sobre um histórico de chamadas.

Entrada: JSON (lista de linhas no formato de `llm_call_ledger`) — ledger real exportado ou o sintético
`scripts/data/waste_synthetic_history.json`. Mesmas definições das consultas SQL
(`applications/services/api-node/scripts/sql/desperdicio_pct_por_fase_semana.sql` e
`segundos_desperdicados_por_fase_semana.sql`):

  bucket       = call_reason; ausente vira `nao_medido`.
  dup_rede     = linha com a MESMA call_idem_key de uma linha anterior em até `--janela-s` s. Gasto real (vai para
                 `retry`), mas NÃO é outra chamada de negócio.
  desperdício  = retry + repair + rework. `escalation` é reportada à parte.
  segundos     = duration_ms (tempo no provedor; PISO do relógio perdido, sem backoff nem fila).

Uso:
  python3 scripts/waste_report.py scripts/data/waste_synthetic_history.json
  python3 scripts/waste_report.py --gerar-sintetico scripts/data/waste_synthetic_history.json   # regrava o sintético (seed fixa)
Somente leitura do JSON de entrada; nunca acessa banco, rede nem produção. Sem PII: só ids, motivos, tokens e USD.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

WASTE = ("retry", "repair", "rework")
BUCKETS = ("primary", "retry", "repair", "rework", "escalation", "support", "nao_medido")


def _ts(v: str) -> datetime:
    return datetime.fromisoformat(str(v).replace("Z", "+00:00"))


def _week(d: datetime) -> str:
    """Segunda-feira da semana (igual a date_trunc('week') do Postgres)."""
    return (d - timedelta(days=d.weekday())).date().isoformat()


def classify(rows: list[dict], janela_s: int = 300) -> list[dict]:
    """Devolve cópias das linhas com `bucket` e `dup_rede`."""
    ordered = sorted(enumerate(rows), key=lambda t: (_ts(t[1]["created_at"]), t[0]))
    last_by_key: dict[str, datetime] = {}
    out = []
    for _, r in ordered:
        ts = _ts(r["created_at"])
        key = r.get("call_idem_key")
        dup = False
        if key:
            prev = last_by_key.get(key)
            dup = prev is not None and (ts - prev).total_seconds() <= janela_s
            last_by_key[key] = ts
        motivo = r.get("call_reason") or "nao_medido"
        out.append({**r, "dup_rede": dup, "bucket": "retry" if dup else motivo, "_semana": _week(ts)})
    return out


def report(rows: list[dict], janela_s: int = 300) -> list[dict]:
    agg: dict[tuple, dict] = defaultdict(lambda: {
        "usd": defaultdict(float), "s": defaultdict(float), "linhas": 0, "negocio": 0, "dups": 0, "sem_duracao": 0})
    for r in classify(rows, janela_s):
        a = agg[(r["_semana"], r.get("phase") or "unattributed")]
        a["usd"][r["bucket"]] += float(r.get("cost_usd") or 0)
        if r.get("duration_ms") is None:
            a["sem_duracao"] += 1
        else:
            a["s"][r["bucket"]] += float(r["duration_ms"]) / 1000.0
        a["linhas"] += 1
        a["dups" if r["dup_rede"] else "negocio"] += 1
    res = []
    for (semana, fase), a in agg.items():
        tot, tot_s = sum(a["usd"].values()), sum(a["s"].values())
        w, w_s = sum(a["usd"][b] for b in WASTE), sum(a["s"][b] for b in WASTE)
        pct = lambda x, t: round(100 * x / t, 1) if t else None  # noqa: E731
        res.append({
            "semana": semana, "fase": fase, "gasto_total_usd": round(tot, 4),
            "retry_usd": round(a["usd"]["retry"], 4), "repair_usd": round(a["usd"]["repair"], 4),
            "rework_usd": round(a["usd"]["rework"], 4), "desperdicio_usd": round(w, 4),
            "pct_desperdicio": pct(w, tot), "pct_escalation": pct(a["usd"]["escalation"], tot),
            "pct_nao_medido": pct(a["usd"]["nao_medido"], tot),
            "segundos_total": round(tot_s, 1), "segundos_desperdicados": round(w_s, 1),
            "pct_segundos_desperdicados": pct(w_s, tot_s), "sem_duracao": a["sem_duracao"],
            "linhas_pagas": a["linhas"], "chamadas_de_negocio": a["negocio"], "duplicatas_de_rede": a["dups"],
        })
    return sorted(res, key=lambda x: (x["semana"], x["fase"]), reverse=False)


def totals(rows: list[dict], janela_s: int = 300) -> dict:
    by_fase: dict[str, dict] = {}
    for x in report(rows, janela_s):
        t = by_fase.setdefault(x["fase"], {"gasto": 0.0, "desp": 0.0, "seg": 0.0, "seg_desp": 0.0})
        t["gasto"] += x["gasto_total_usd"]; t["desp"] += x["desperdicio_usd"]
        t["seg"] += x["segundos_total"]; t["seg_desp"] += x["segundos_desperdicados"]
    return by_fase


def render(rows: list[dict], janela_s: int = 300) -> str:
    lines = [f"Linhas lidas: {len(rows)} | janela de deduplicação: {janela_s}s", "",
             "semana      fase        total_usd  retry   repair  rework  desp_usd  %desp  %escal  %nao_med  seg_desp  %seg  negocio  dups",
             "-" * 124]
    for x in report(rows, janela_s):
        f = lambda v: "  -  " if v is None else f"{v:5.1f}"  # noqa: E731
        lines.append(f"{x['semana']}  {x['fase']:<10} {x['gasto_total_usd']:9.4f} {x['retry_usd']:7.4f} {x['repair_usd']:7.4f} "
                     f"{x['rework_usd']:7.4f} {x['desperdicio_usd']:9.4f} {f(x['pct_desperdicio'])}  {f(x['pct_escalation'])}   "
                     f"{f(x['pct_nao_medido'])}   {x['segundos_desperdicados']:8.1f} {f(x['pct_segundos_desperdicados'])}  "
                     f"{x['chamadas_de_negocio']:7d}  {x['duplicatas_de_rede']:4d}")
    lines += ["", "Total por fase (todas as semanas):"]
    for fase, t in sorted(totals(rows, janela_s).items()):
        p = round(100 * t["desp"] / t["gasto"], 1) if t["gasto"] else None
        lines.append(f"  {fase:<10} gasto US$ {t['gasto']:.4f} | desperdício US$ {t['desp']:.4f} ({p}%) | "
                     f"segundos desperdiçados {t['seg_desp']:.1f} de {t['seg']:.1f}")
    return "\n".join(lines)


def synthetic(seed: int = 14, projetos: int = 12) -> list[dict]:
    """Histórico SINTÉTICO (não é dado real). 4 semanas, 2 fases, preços fictícios por token (sem relação com a tabela real)."""
    rnd = random.Random(seed)
    base = datetime(2026, 10, 5, 9, 0, tzinfo=timezone.utc)  # segunda-feira
    rows, rid = [], 0

    def add(ts, pid, phase, purpose, reason, key, inp, out, secs, model="claude-sonnet-5-5"):
        nonlocal rid
        rid += 1
        usd = (inp * 2 + out * 10) / 1e6  # preço fictício 2/10 por MTok
        rows.append({"id": rid, "created_at": ts.isoformat(), "project_id": f"proj-{pid:02d}", "phase": phase,
                     "purpose": purpose, "model": model, "call_reason": reason, "call_idem_key": key,
                     "input_tokens": inp, "output_tokens": out, "cost_usd": round(usd, 6), "duration_ms": int(secs * 1000)})

    for p in range(projetos):
        wk = p % 4
        t0 = base + timedelta(weeks=wk, hours=rnd.randint(0, 40))
        # Bancada: CTO (entrada alta) com repair ocasional
        key = f"proj-{p:02d}|-|CTO:spec_intake|r0.p0"
        add(t0, p, "bancada", "CTO:spec_intake", "primary", key, rnd.randint(55000, 75000), rnd.randint(8000, 14000), rnd.uniform(60, 140))
        if rnd.random() < 0.45:
            add(t0 + timedelta(minutes=3), p, "bancada", "CTO:spec_intake", "repair",
                f"proj-{p:02d}|-|CTO:spec_intake|r0.p1", rnd.randint(60000, 80000), rnd.randint(9000, 16000), rnd.uniform(70, 160))
        # retry de rede: o mesmo reenvio é registrado duas vezes com a mesma chave (gasto real, 1 chamada de negócio)
        if rnd.random() < 0.2:
            add(t0 + timedelta(seconds=40), p, "bancada", "CTO:spec_intake", "primary", key, 60000, 9000, 80)
        # Fábrica: Dev/QA por task, com rework
        for task in range(rnd.randint(3, 6)):
            tt = t0 + timedelta(days=1, hours=task)
            for role, inp, out in (("DEV", 38000, 22000), ("QA", 26000, 5000)):
                st = f"{role}:implement_task" if role == "DEV" else f"{role}:validate_task"
                rw = 0
                add(tt, p, "fabrica", st, "primary", f"proj-{p:02d}|T{task}|{st}|r0.p0",
                    int(inp * rnd.uniform(.8, 1.2)), int(out * rnd.uniform(.7, 1.3)), rnd.uniform(40, 120))
                while rw < 3 and rnd.random() < (0.35 if role == "DEV" else 0.2):
                    rw += 1
                    tt += timedelta(minutes=12)
                    add(tt, p, "fabrica", st, "rework", f"proj-{p:02d}|T{task}|{st}|r{rw}.p0",
                        int(inp * 1.2), int(out * 1.4), rnd.uniform(60, 180), model="claude-opus-5-5")
                    if rnd.random() < 0.15:
                        add(tt + timedelta(minutes=4), p, "fabrica", st, "repair", f"proj-{p:02d}|T{task}|{st}|r{rw}.p1",
                            int(inp * 1.3), int(out * 1.4), rnd.uniform(60, 180), model="claude-opus-5-5")
        # Cyborg em ~1 de 4 projetos que falham
        if rnd.random() < 0.25:
            add(t0 + timedelta(days=3), p, "fabrica", "cyborg_v3:engineer_session", "escalation", None,
                180000, 40000, 1500, model="claude-opus-5-5")
        # suporte (classificadores) e linhas sem motivo (ponto de chamada não coberto)
        add(t0 - timedelta(minutes=5), p, "bancada", "runner:module", "support", None, 900, 10, 2, model="claude-haiku-4-5")
        add(t0 + timedelta(hours=2), p, "bancada", "spec_validator", None, None, 70000, 3000, 45)
    return sorted(rows, key=lambda r: (r["created_at"], r["id"]))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("historico", help="JSON com a lista de linhas do ledger (ou destino de --gerar-sintetico)")
    ap.add_argument("--janela-s", type=int, default=300, help="janela de deduplicação por call_idem_key (s)")
    ap.add_argument("--gerar-sintetico", action="store_true", help="grava o histórico sintético (seed fixa) no caminho dado")
    ap.add_argument("--json", action="store_true", help="saída em JSON em vez de tabela")
    a = ap.parse_args(argv)
    if a.gerar_sintetico:
        data = synthetic()
        with open(a.historico, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
        print(f"sintético gravado: {len(data)} linhas em {a.historico}")
        return 0
    with open(a.historico, encoding="utf-8") as fh:
        rows = json.load(fh)
    print(json.dumps(report(rows, a.janela_s), ensure_ascii=False, indent=1) if a.json else render(rows, a.janela_s))
    return 0


if __name__ == "__main__":
    sys.exit(main())
