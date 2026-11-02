#!/usr/bin/env python3
"""Plano de evolução v2, tarefa 1.5 (a) — MEDIÇÃO de identidade de prefixo e economia de cache de prompt.

Só mede e simula. Não altera preço, prompt, flag nem comportamento do Genesis. Somente leitura do JSON.

Entrada: JSON com a lista de chamadas (ledger real exportado, ou o sintético gerado aqui). Campos por linha:
  created_at, project_id, purpose (ponto de chamada), model, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens                       (obrigatórios; os de cache podem ser null = não medido)
  votes                                                       (opcional: SPEC_VALIDATOR_VOTES do run; padrão 1)
  segments                                                    (opcional: [[hash, tokens], ...] na ORDEM do prompt;
                                                               sem isso a identidade de prefixo fica "n/m")
`segments` não existe no ledger de hoje (só `prompt_hash` do prompt inteiro). Para obtê-lo é preciso capturar,
no ponto de chamada, o hash e a contagem de tokens de cada bloco (system, tarefa, spec, charter...). Isso é
instrumentação de produção e NÃO foi feito nesta tarefa. Use `segmentar()` num prompt capturado localmente.

Métricas por ponto de chamada (purpose):
  hit_rate_pedido  = cache_read / (input + cache_read)                       (definição do pedido 1.5)
  hit_rate_total   = cache_read / (input + cache_read + cache_write)         (definição do doc 08a E13)
  identidade       = Σ tokens do prefixo comum com a chamada anterior do MESMO projeto e ponto / Σ tokens da chamada
                     (também a versão restrita à janela do TTL do cache, 300 s)
  custo do cache   = escrita 1,25x sobre o que não foi lido; leitura a r x. Com votes=1 e sem reuso, é só multa.
  ponto de equilíbrio da identidade com votes=1: C/P > (w-1)/(w-r)  (~21% com w=1,25 e r=0,05 a 0,1)
  ganho com votes>1 = P * p * (v - (w + (v-1) * r)) por run, só do lado da ENTRADA (a saída também multiplica por v
                     e a qualidade muda: isso é decisão de produto, não de cache).

Preços são PARÂMETRO (`--precos oficial|repo|ambos|arquivo.json`). `oficial` = doc 10 (Opus 5.5 = 4/20, leitura 0,05x
para Opus 5.5 e Sonnet 5.5). `repo` = `modelPricing.ts` de hoje (Opus 5/25, leitura 0,1x). A divergência é registrada
na saída; `modelPricing.ts` NÃO é alterado.

Uso:
  python3 -I scripts/cache_prefix_report.py scripts/data/cache_prefix_synthetic_history.json --precos ambos
  python3 -I scripts/cache_prefix_report.py --gerar-sintetico scripts/data/cache_prefix_synthetic_history.json
  PYTHONPATH=applications python3 -I scripts/cache_prefix_report.py --sonda-estrutura    # ordem real do prompt (código)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

TTL_S = 300  # TTL padrão do cache de prompt (5 min). Cache de 1 h custa 2x na escrita: não modelado aqui.
DEFAULT_VOTES_GRID = (1, 2, 3, 5)

# (substring do id do modelo, entrada USD/MTok, saída USD/MTok, multiplicador de leitura r, de escrita w). 1ª que casar vale.
PRECOS = {
    "oficial": [  # doc 10 §A.2 [verificado em 02/11/2026, fonte 1]
        ("opus-5-5", 4.0, 20.0, 0.05, 1.25), ("opus", 5.0, 25.0, 0.10, 1.25),
        ("sonnet-5-5", 2.0, 10.0, 0.05, 1.25), ("sonnet-5", 2.0, 10.0, 0.10, 1.25), ("sonnet", 3.0, 15.0, 0.10, 1.25),
        ("haiku-5-5", 0.10, 0.50, 0.10, 1.25), ("haiku", 1.0, 5.0, 0.10, 1.25),
        ("fable", 10.0, 50.0, 0.025, 1.25), ("", 3.0, 15.0, 0.10, 1.25)],
    "repo": [  # modelPricing.ts de hoje: substring `opus` = 5/25, leitura 0,1x para tudo
        ("haiku", 1.0, 5.0, 0.10, 1.25), ("opus", 5.0, 25.0, 0.10, 1.25), ("sonnet-5", 2.0, 10.0, 0.10, 1.25),
        ("sonnet", 3.0, 15.0, 0.10, 1.25), ("fable", 10.0, 50.0, 0.10, 1.25), ("", 3.0, 15.0, 0.10, 1.25)],
}


def preco(tabela: list, model: str) -> tuple[float, float, float, float]:
    m = (model or "").lower()
    for sub, i, o, r, w in tabela:
        if sub in m:
            return i, o, r, w
    return tabela[-1][1:]


def carregar_tabela(arg: str) -> dict[str, list]:
    if arg == "ambos":
        return dict(PRECOS)
    if arg in PRECOS:
        return {arg: PRECOS[arg]}
    with open(arg, encoding="utf-8") as fh:  # arquivo: lista de [substring, in, out, r, w]
        return {"arquivo": [tuple(x) for x in json.load(fh)]}


# ── segmentos e prefixo comum ─────────────────────────────────────────────────

def segmentar(blocos: list[tuple[str, str]], chars_por_token: float = 4.0) -> list[list]:
    """[(nome, texto)] na ordem do prompt -> [[hash12, tokens_estimados], ...]. Guarda só hash e tamanho, nunca o texto."""
    return [[hashlib.sha256(t.encode()).hexdigest()[:12], max(1, round(len(t) / chars_por_token))] for _, t in blocos]


def prefixo_comum_tokens(a: list, b: list) -> int:
    """Tokens dos blocos iniciais IGUAIS (para no primeiro bloco diferente: cache é por prefixo contíguo)."""
    n = 0
    for (ha, ta), (hb, _tb) in zip(a, b):
        if ha != hb:
            break
        n += int(ta)
    return n


def _ts(v: str) -> datetime:
    return datetime.fromisoformat(str(v).replace("Z", "+00:00"))


def _tok(r: dict) -> int:
    return int(r.get("input_tokens") or 0) + int(r.get("cache_read_tokens") or 0) + int(r.get("cache_write_tokens") or 0)


def equilibrio_identidade(r: float, w: float) -> float:
    """Identidade mínima C/P para o cache compensar com votes=1: C(1-r) > (w-1)(P-C)  =>  C/P > (w-1)/(w-r)."""
    return (w - 1.0) / (w - r)


def votes_minimo(r: float, w: float) -> int:
    """Menor v inteiro com custo cacheado (w + (v-1) r) < custo sem cache (v)."""
    v = 1
    while w + (v - 1) * r >= v:
        v += 1
    return v


# ── análise por ponto de chamada ──────────────────────────────────────────────

def analisar(linhas: list[dict], tabela: list) -> list[dict]:
    pts: dict[str, list[dict]] = defaultdict(list)
    for r in linhas:
        pts[r.get("purpose") or "?"].append(r)
    out = []
    for purpose, rs in pts.items():
        rs.sort(key=lambda r: _ts(r["created_at"]))
        n = len(rs)
        inp = sum(int(r.get("input_tokens") or 0) for r in rs)
        med_cache = [r for r in rs if r.get("cache_read_tokens") is not None]
        rd = sum(int(r["cache_read_tokens"]) for r in med_cache)
        wr = sum(int(r.get("cache_write_tokens") or 0) for r in med_cache)
        inp_m = sum(int(r.get("input_tokens") or 0) for r in med_cache)
        hit_ped = rd / (inp_m + rd) if (inp_m + rd) else None
        hit_tot = rd / (inp_m + rd + wr) if (inp_m + rd + wr) else None
        # custo real de entrada vs contrafactual sem cache (mesmos tokens)
        real = sem = pen = sav = 0.0
        for r in rs:
            i, _o, rr, ww = preco(tabela, r.get("model") or "")
            a, c, w_ = int(r.get("input_tokens") or 0), int(r.get("cache_read_tokens") or 0), int(r.get("cache_write_tokens") or 0)
            real += (a + c * rr + w_ * ww) * i / 1e6
            sem += (a + c + w_) * i / 1e6
            pen += w_ * (ww - 1.0) * i / 1e6
            sav += c * (1.0 - rr) * i / 1e6
        # identidade de prefixo (precisa de segments)
        ult: dict[str, dict] = {}
        c_all = t_all = c_ttl = t_ttl = 0
        sim_gain = sim_pen = 0.0
        com_seg = pares_ttl = 0
        # Só runs com votes=1: a pergunta é "há reuso ENTRE runs?". Reuso dentro do run (votes>1) é a grade abaixo.
        for r in (x for x in rs if int(x.get("votes") or 1) <= 1):
            seg = r.get("segments")
            if not seg:
                continue
            com_seg += 1
            prev = ult.get(r["project_id"])
            T = sum(int(t) for _h, t in seg)
            if prev is not None:
                C = prefixo_comum_tokens(prev["segments"], seg)
                dt = (_ts(r["created_at"]) - _ts(prev["created_at"])).total_seconds()
                c_all += C; t_all += T
                if dt <= TTL_S:
                    c_ttl += C; t_ttl += T; pares_ttl += 1
                i, _o, rr, ww = preco(tabela, r.get("model") or "")
                Ce = C if dt <= TTL_S else 0  # fora do TTL o cache expirou: nada a ler
                custo_cache = (Ce * rr + (T - Ce) * ww) * i / 1e6
                sim_gain += T * i / 1e6 - custo_cache
            else:
                i, _o, rr, ww = preco(tabela, r.get("model") or "")
                sim_gain += T * i / 1e6 - T * ww * i / 1e6     # 1ª chamada do projeto: só escreve (multa)
            ult[r["project_id"]] = r
        # votes>1 (lado da entrada): P médio das chamadas, nº de runs = Σ 1/votes
        runs = sum(1.0 / max(1, int(r.get("votes") or 1)) for r in rs)
        P = (sum(_tok(r) for r in rs) / n) if n else 0
        i0, _o0, r0, w0 = preco(tabela, rs[0].get("model") or "")
        grade = []
        for v in DEFAULT_VOTES_GRID:
            sem_c = v * P * i0 / 1e6
            com_c = P * (w0 + (v - 1) * r0) * i0 / 1e6
            grade.append({"votes": v, "entrada_sem_cache_usd_por_run": round(sem_c, 5),
                          "entrada_com_cache_usd_por_run": round(com_c, 5), "ganho_por_run": round(sem_c - com_c, 5),
                          "ganho_total_usd": round((sem_c - com_c) * runs, 4)})
        out.append({
            "purpose": purpose, "chamadas": n, "projetos": len({r["project_id"] for r in rs}),
            "tokens_prompt_medio": round(P), "tokens_entrada_input": inp,
            "hit_rate_pedido": None if hit_ped is None else round(100 * hit_ped, 1),
            "hit_rate_total": None if hit_tot is None else round(100 * hit_tot, 1),
            "cache_medido_em": f"{len(med_cache)}/{n}",
            "identidade_prefixo_pct": None if not t_all else round(100 * c_all / t_all, 1),
            "identidade_prefixo_no_ttl_pct": None if not t_ttl else round(100 * c_ttl / t_ttl, 1),
            "chamadas_com_segments_votes1": com_seg, "pares_no_ttl": pares_ttl,
            "custo_real_entrada_usd": round(real, 4), "custo_sem_cache_usd": round(sem, 4),
            "multa_escrita_usd": round(pen, 4), "economia_leitura_usd": round(sav, 4),
            "liquido_cache_atual_usd": round(sav - pen, 4),
            "sim_votes1_cache_ligado_liquido_usd": None if not com_seg else round(sim_gain, 4),
            "equilibrio_identidade_votes1_pct": round(100 * equilibrio_identidade(r0, w0), 1),
            "votes_minimo_para_cache": votes_minimo(r0, w0),
            "preco_usado": {"in": i0, "out": _o0, "r": r0, "w": w0}, "grade_votes": grade, "runs": round(runs, 2),
        })
    return sorted(out, key=lambda x: x["custo_sem_cache_usd"], reverse=True)


def veredito(x: dict) -> str:
    ident, sim = x["identidade_prefixo_no_ttl_pct"], x["sim_votes1_cache_ligado_liquido_usd"]
    eq = x["equilibrio_identidade_votes1_pct"]
    if x["chamadas_com_segments_votes1"] == 0:
        return "identidade NÃO medida (faltam segments): sem dado real, cache em votes=1 fica como proposta"
    if ident is None:
        return (f"identidade {x['identidade_prefixo_pct']}% mas NENHUM par de chamadas dentro do TTL de {TTL_S}s: o cache "
                "expiraria antes da próxima leitura, então com votes=1 seria só multa de escrita")
    if sim is not None and sim > 0:
        return f"identidade no TTL {ident}% > equilíbrio {eq}%: cache com votes=1 teria ganho líquido simulado"
    return f"identidade no TTL {ident}% <= equilíbrio {eq}%: cache com votes=1 só adiciona multa; ganho só com votes>=2"


def render(linhas: list[dict], tabelas: dict[str, list]) -> str:
    L = [f"Linhas lidas: {len(linhas)} | TTL do cache: {TTL_S}s | pontos de chamada: {len({r.get('purpose') for r in linhas})}"]
    for nome, tab in tabelas.items():
        L += ["", f"=== Tabela de preços: {nome} ==="]
        for x in analisar(linhas, tab):
            p = x["preco_usado"]
            L += [f"-- {x['purpose']}  ({x['chamadas']} chamadas, {x['projetos']} projetos, prompt médio {x['tokens_prompt_medio']} tok, "
                  f"preço in/out {p['in']}/{p['out']}, r={p['r']}, w={p['w']})",
                  f"   hit-rate (read/(input+read)) = {x['hit_rate_pedido']}% | (read/(input+read+write)) = {x['hit_rate_total']}% | cache medido em {x['cache_medido_em']}",
                  f"   identidade de prefixo (runs votes=1) = {x['identidade_prefixo_pct']}% (no TTL: {x['identidade_prefixo_no_ttl_pct']}%, {x['pares_no_ttl']} pares) | equilíbrio votes=1: {x['equilibrio_identidade_votes1_pct']}% | votes mínimo p/ cache: {x['votes_minimo_para_cache']}",
                  f"   cache atual: multa de escrita US$ {x['multa_escrita_usd']} | economia de leitura US$ {x['economia_leitura_usd']} | líquido US$ {x['liquido_cache_atual_usd']}",
                  f"   simulação votes=1 com cache LIGADO: líquido US$ {x['sim_votes1_cache_ligado_liquido_usd']}",
                  "   votes>1 (só entrada, por run): " + "; ".join(
                      f"v={g['votes']}: sem {g['entrada_sem_cache_usd_por_run']} / com {g['entrada_com_cache_usd_por_run']} / ganho {g['ganho_por_run']}"
                      for g in x["grade_votes"]),
                  f"   => {veredito(x)}"]
    if len(tabelas) > 1 and {"oficial", "repo"} <= set(tabelas):
        L += ["", "=== Divergência de preço (oficial x repositório), por ponto: custo de ENTRADA sem cache e líquido do cache atual ==="]
        a, b = ({x["purpose"]: x for x in analisar(linhas, tabelas[k])} for k in ("oficial", "repo"))
        for k in a:
            L.append(f"   {k}: sem cache {a[k]['custo_sem_cache_usd']} (oficial) vs {b[k]['custo_sem_cache_usd']} (repo) | "
                     f"líquido cache {a[k]['liquido_cache_atual_usd']} vs {b[k]['liquido_cache_atual_usd']}")
    return "\n".join(L)


# ── sintético (NÃO é dado real) ───────────────────────────────────────────────

def _h(*p: object) -> str:
    return hashlib.sha256("|".join(map(str, p)).encode()).hexdigest()[:12]


def sintetico(seed: int = 15) -> dict:
    """Cenários (tamanhos em tokens são hipóteses, não medidas):
    spec_validator — votes=1 (maioria, sem cache), votes=3 em alguns projetos com cache ligado; a spec muda a cada rodada;
    CTO:spec_intake — sem cache; repair reemite o prompt anterior + feedback, mas 10 min depois (fora do TTL);
    DEV:implement_task — tarefa variável ANTES da spec estável; sem cache."""
    rnd = random.Random(seed)
    t0 = datetime(2026, 10, 5, 9, 0, tzinfo=timezone.utc)
    rows: list[dict] = []

    def add(ts, pid, purpose, model, segs, out_tok, votes=1, cache=None):
        T = sum(t for _h_, t in segs)
        if cache is None:
            row_cache = {"cache_read_tokens": 0, "cache_write_tokens": 0}
            inp = T
        else:  # cache = (lidos, escritos)
            row_cache = {"cache_read_tokens": cache[0], "cache_write_tokens": cache[1]}
            inp = T - cache[0] - cache[1]
        rows.append({"created_at": ts.isoformat(), "project_id": pid, "purpose": purpose, "model": model,
                     "input_tokens": inp, "output_tokens": out_tok, **row_cache, "votes": votes, "segments": segs})

    OPUS, SON = "us.anthropic.claude-opus-5-5", "us.anthropic.claude-sonnet-5-5"
    for p in range(10):
        pid = f"proj-{p:02d}"
        base = t0 + timedelta(hours=p * 7)
        spec_v = 0
        # spec_validator: 4 rodadas por projeto; 3 projetos usam votes=3 com cache
        votes = 3 if p % 3 == 0 else 1
        for rod in range(4):
            tr = base + timedelta(minutes=rod * rnd.randint(4, 9))
            if rnd.random() > 0.15:
                spec_v += 1          # a spec mudou (padrão); 15% das rodadas revalidam a MESMA spec
            segs = [[_h("sys_ref"), 1800], [_h(pid, "spec", spec_v), int(rnd.uniform(52000, 70000))],
                    [_h(pid, "known", rod), 400]]
            T = sum(t for _a, t in segs)
            for v in range(votes):
                tv = tr + timedelta(seconds=40 * v)
                if votes == 1:
                    add(tv, pid, "spec_validator", OPUS, segs, 4000, votes)
                else:
                    cache = (0, T) if v == 0 else (T, 0)
                    add(tv, pid, "spec_validator", OPUS, segs, 4000, votes, cache)
        # CTO: spec_intake + até 2 repairs 10 min depois, sem cache
        spec_cto = int(rnd.uniform(35000, 45000))
        task = _h("cto", pid)
        for k in range(1 + (rnd.random() < 0.5) + (rnd.random() < 0.2)):
            segs = [[_h("sys_cto"), 8000], [task, 120], [_h(pid, "cto_spec"), spec_cto]]
            if k:  # repair: o prompt anterior inteiro + bloco de feedback no FIM
                segs = segs + [[_h(pid, "repair", k), 900]]
            add(base + timedelta(minutes=30 + 10 * k), pid, "CTO:spec_intake", OPUS, segs, 30000)
        # DEV: tarefa e dependências variáveis ANTES da spec/charter/backlog estáveis
        for t in range(6):
            segs = [[_h("sys_dev"), 6000], [_h(pid, "task", t), 900], [_h(pid, "dep", t), 3500],
                    [_h(pid, "spec_raw"), 30000], [_h(pid, "charter"), 5000], [_h(pid, "backlog"), 8000]]
            add(base + timedelta(hours=1, minutes=3 * t), pid, "DEV:implement_task", SON, segs, 12000)
    rows.sort(key=lambda r: (r["created_at"], r["project_id"]))
    return {"sintetico": True, "aviso": "dados fictícios para exercitar o script; NÃO são medidas de produção", "linhas": rows}


# ── sonda estrutural: ordem real do prompt (usa o código, não dados de produção) ──

def sonda_estrutura() -> str:
    import os
    sys.path.insert(0, os.environ.get("PYTHONPATH", "applications").split(os.pathsep)[0])
    from orchestrator.agents.runtime import build_user_message  # type: ignore

    def comum(a: str, b: str) -> int:
        n = 0
        for x, y in zip(a, b):
            if x != y:
                break
            n += 1
        return n

    spec, charter, backlog = "S" * 30000, "C" * 5000, "B" * 8000
    ctx = {"spec_raw": spec, "charter": charter, "backlog": backlog}

    def dev(i: int) -> str:
        e = {**ctx, "current_task": {"id": f"T-{i}", "title": f"tarefa {i}", "description": f"descrição da tarefa {i}"},
             "dependency_code": {f"src/mod{i}.ts": "x" * 500}}
        return build_user_message({"project_id": "p", "mode": "implement_task", "inputs": e}, role="DEV", model="claude-sonnet-5-5")

    def cto(spec_txt: str) -> str:
        e = {"spec_raw": spec_txt, "charter": charter}
        return build_user_message({"project_id": "p", "mode": "spec_intake_and_normalize", "task": "Normalizar a spec", "inputs": e},
                                  role="CTO", model="claude-opus-5-5")

    a, b = dev(1), dev(2)
    c1, c2 = cto(spec), cto(spec[:15000] + "EDIT" + spec[15004:])
    c3 = cto(spec)
    L = ["Sonda estrutural (build_user_message real; conteúdo sintético; mede ORDEM, não produção):",
         f"  DEV tarefa 1 -> 2 (spec/charter/backlog iguais): prefixo comum {comum(a, b)}/{len(b)} chars = {100 * comum(a, b) / len(b):.1f}% "
         f"(a tarefa e o código de dependência vêm ANTES da spec; a spec estável fica depois do 1º trecho variável)",
         f"  CTO mesma spec, 2ª chamada idêntica: {100 * comum(c1, c3) / len(c3):.1f}%",
         f"  CTO spec com 1 edição no meio (50%): {100 * comum(c1, c2) / len(c2):.1f}% (prefixo até a edição; o resto não reaproveita)"]
    return "\n".join(L)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("historico", nargs="?", help="JSON com as chamadas (lista ou {linhas: [...]}) ou destino de --gerar-sintetico")
    ap.add_argument("--precos", default="ambos", help="oficial | repo | ambos | arquivo.json")
    ap.add_argument("--gerar-sintetico", action="store_true")
    ap.add_argument("--sonda-estrutura", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    if a.sonda_estrutura:
        print(sonda_estrutura())
        return 0
    if not a.historico:
        ap.error("informe o JSON de histórico")
    if a.gerar_sintetico:
        d = sintetico()
        with open(a.historico, "w", encoding="utf-8") as fh:
            json.dump(d, fh, ensure_ascii=False, indent=None, separators=(",", ":"))
        print(f"sintético gravado: {len(d['linhas'])} linhas em {a.historico}")
        return 0
    with open(a.historico, encoding="utf-8") as fh:
        d = json.load(fh)
    linhas = d["linhas"] if isinstance(d, dict) else d
    tabs = carregar_tabela(a.precos)
    if a.json:
        print(json.dumps({k: analisar(linhas, t) for k, t in tabs.items()}, ensure_ascii=False, indent=1))
    else:
        if isinstance(d, dict) and d.get("sintetico"):
            print("*** HISTÓRICO SINTÉTICO: números ilustram o script, não medem produção ***")
        print(render(linhas, tabs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
