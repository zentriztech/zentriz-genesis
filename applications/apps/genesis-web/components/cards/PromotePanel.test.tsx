import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { detailOf, journeyOf } from "@/lib/cards/cardFixtures";
import { PromotePanel, promoteChecks } from "./PromotePanel";
import type { CardRunner } from "./useCardRunner";

const runner = (over: Partial<CardRunner> = {}): CardRunner => ({
  busy: null, error: null, notice: null, revalidation: null, promoted: null, restart: null, run: vi.fn(async () => undefined), dismiss: vi.fn(), ...over,
});

describe("promoteChecks (pré-requisitos lidos dos bloqueios do servidor)", () => {
  it("pronto e sem bloqueios: tudo atendido", () => {
    expect(promoteChecks(detailOf("ready"), journeyOf("ready"))).toEqual({ spec: "ok", budget: "ok", base: "ok" });
  });
  it("base vencida: só a base fica pendente", () => {
    expect(promoteChecks(detailOf("ready"), journeyOf("ready-base-stale"))).toEqual({ spec: "ok", budget: "ok", base: "pending" });
  });
  it("orçamento pausado: só o saldo fica pendente", () => {
    expect(promoteChecks(detailOf("ready"), journeyOf("ready-budget-paused"))).toMatchObject({ spec: "ok", budget: "pending", base: "ok" });
  });
  it("bloqueador 'globs não conferidos' (backend novo, código com GLOB) deixa a base pendente e bloqueia o botão", () => {
    const j = { ...journeyOf("ready"), blockers: [{ code: "CARD_GLOBS_UNVERIFIED", message: "Globs não conferidos.", userMessage: "Os arquivos permitidos do RFC não foram conferidos contra a versão corrente. Revalide.", details: undefined }] };
    expect(promoteChecks(detailOf("ready"), j)).toMatchObject({ spec: "ok", base: "pending" });
    render(<PromotePanel card={detailOf("ready")} journey={j} runner={runner()} />);
    expect(screen.getByRole("button", { name: "Promover à fábrica" })).toBeDisabled();
  });
  it("sem jornada: saldo e base ficam 'conferidos ao promover' (o servidor decide)", () => {
    expect(promoteChecks(detailOf("ready"), null)).toEqual({ spec: "ok", budget: "unknown", base: "unknown" });
  });
});

describe("PromotePanel", () => {
  it("orçamento negado pelo Guard: promover desabilitado e a razão aparece em texto", () => {
    render(<PromotePanel card={detailOf("ready")} journey={journeyOf("ready-budget-paused")} runner={runner()} />);
    expect(screen.getByRole("button", { name: "Promover à fábrica" })).toBeDisabled();
    expect(screen.getByRole("list", { name: "Pré-requisitos da promoção" })).toHaveTextContent("Pendente: saldo livre");
    expect(screen.getByText(/indisponível enquanto houver bloqueio/)).toBeInTheDocument();
  });

  it("promover e revalidar acionam o runner uma vez cada", async () => {
    const r = runner();
    render(<PromotePanel card={detailOf("ready")} journey={journeyOf("ready")} runner={r} />);
    await userEvent.click(screen.getByRole("button", { name: "Promover à fábrica" }));
    await userEvent.click(screen.getByRole("button", { name: "Revalidar" }));
    expect(r.run).toHaveBeenNthCalledWith(1, "promote");
    expect(r.run).toHaveBeenNthCalledWith(2, "revalidate");
  });

  it("em andamento: botão 'Promovendo…' desabilitado (clique duplo não duplica)", () => {
    render(<PromotePanel card={detailOf("ready")} journey={journeyOf("ready")} runner={runner({ busy: "promote" })} />);
    expect(screen.getByRole("button", { name: "Promovendo…" })).toBeDisabled();
  });

  it("depois da promoção mostra filho e PR (journey.execution.prUrl), sem botão", () => {
    render(<PromotePanel card={detailOf("delivered")} journey={journeyOf("delivered")} runner={runner()} />);
    expect(screen.getByRole("link", { name: /Evolução v2/ })).toHaveAttribute("href", expect.stringMatching(/^\/projects\//));
    expect(screen.getByRole("link", { name: /abrir no GitHub/ })).toHaveAttribute("href", "https://github.com/zentriz-demo/entregas/pull/42");
    expect(screen.queryByRole("button", { name: /Promover/ })).not.toBeInTheDocument();
  });

  it("Y-20: enquanto a situação do card carrega (journeyLoading) 'Promover' fica desabilitado, com aviso de que o servidor está sendo consultado", () => {
    render(<PromotePanel card={detailOf("ready")} journey={null} runner={runner()} journeyLoading />);
    expect(screen.getByRole("button", { name: "Promover à fábrica" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Conferindo a situação do card");
  });

  it("Y-18: prUrl que não é https:// (javascript:, data:, http:) não vira link", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "http://github.com/x/y/pull/1"]) {
      const j = journeyOf("delivered");
      const { unmount } = render(<PromotePanel card={{ ...detailOf("delivered"), prUrl: bad }} journey={{ ...j, execution: j.execution ? { ...j.execution, prUrl: bad } : null }} runner={runner()} />);
      expect(screen.queryByRole("link", { name: /abrir no GitHub/ }), bad).not.toBeInTheDocument();
      unmount();
    }
  });

  it("AB-03: card pronto cujo papel não pode promover (actions.promote=false) não mostra o botão que daria 403 e explica por quê", () => {
    const card = { ...detailOf("ready"), actions: { ...detailOf("ready").actions, promote: false } };
    render(<PromotePanel card={card} journey={journeyOf("ready")} runner={runner()} />);
    expect(screen.queryByRole("button", { name: /Promover à fábrica/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("promote-not-allowed")).toHaveTextContent(/autor do card ou um administrador do tenant/);
    expect(screen.getByTestId("promote-not-allowed")).toHaveTextContent(/conta de gestão/);
  });
});
