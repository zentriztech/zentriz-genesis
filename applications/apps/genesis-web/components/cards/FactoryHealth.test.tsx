import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { makeCard, makeDetail } from "@/lib/cards/cardFixtures";
import type { FactoryGates } from "@/lib/cards/types";
import { CardTile } from "./CardTile";
import { FactoryHealthPanel } from "./FactoryHealth";

const GATES: FactoryGates = {
  scope: { status: "passed", detail: "diff real (3 arquivo(s)) dentro do files_allowed" },
  symbols: { status: "passed", detail: "nenhuma remoção" },
  qa: { status: "passed", detail: "QA executado" },
  fullTest: { status: "failed", detail: "reprovada: build quebrado (TS2554)" },
  baseline: { status: "not_run", detail: "baseline NÃO medida" },
};

describe("saúde da Fábrica no card (4.5c)", () => {
  it("cartão com gate reprovado mostra 'Fábrica: falhou' em texto; sem gates registrados não mostra nada", () => {
    const { rerender } = render(<CardTile card={makeCard({ code: "TK-0005", state: "delivered", factoryHealth: "failed", factoryGates: GATES })} />);
    expect(screen.getByTestId("factory-health-failed")).toHaveTextContent("Fábrica: falhou");
    rerender(<CardTile card={makeCard({ code: "TK-0005", state: "delivered", factoryHealth: "attention", factoryGates: GATES })} />);
    expect(screen.getByTestId("factory-health-attention")).toHaveTextContent("Fábrica: atenção");
    rerender(<CardTile card={makeCard({ code: "TK-0005", state: "delivered", factoryHealth: "ok", factoryGates: GATES })} />);
    expect(screen.getByTestId("factory-health-ok")).toHaveTextContent("Fábrica: ok");
    rerender(<CardTile card={makeCard({ code: "TK-0005", state: "in_factory" })} />);
    expect(screen.queryByText(/Fábrica:/)).not.toBeInTheDocument();
  });

  it("cartão avisa quando o código-base veio do disco", () => {
    render(<CardTile card={makeCard({ state: "in_factory", codeBaseWarning: "ATENÇÃO: copiado do disco" })} />);
    expect(screen.getByTestId("tile-code-base-warning")).toHaveTextContent("copiado do disco");
  });

  it("detalhe: lista os 5 gates com o texto do servidor e avisa que 'não executado' não é aprovação", () => {
    render(<FactoryHealthPanel card={makeDetail({ factoryHealth: "failed", factoryGates: GATES })} />);
    const list = screen.getByRole("list", { name: "Gates da Fábrica" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    expect(list).toHaveTextContent("TSK-FULL-TEST (e2e): FALHOU — reprovada: build quebrado (TS2554)");
    expect(list).toHaveTextContent("Baseline / não-regressão (P2P): não executado / sem evidência");
    expect(screen.getByText(/Não executado” não é aprovação/)).toBeInTheDocument();
    expect(screen.getByText(/a Fábrica aceitou o filho, mas há gate reprovado/)).toBeInTheDocument();
  });

  it("detalhe: alerta de código-base do disco aparece mesmo sem gates", () => {
    render(<FactoryHealthPanel card={makeDetail({ factoryHealth: null, factoryGates: null, codeBaseWarning: "ATENÇÃO: o disco pode conter código NÃO mergeado" })} />);
    expect(screen.getByTestId("code-base-warning")).toHaveTextContent("NÃO mergeado");
    expect(screen.queryByRole("list", { name: "Gates da Fábrica" })).not.toBeInTheDocument();
  });

  it("sem gates nem alerta: não renderiza nada", () => {
    const { container } = render(<FactoryHealthPanel card={makeDetail({})} />);
    expect(container).toBeEmptyDOMElement();
  });
});
