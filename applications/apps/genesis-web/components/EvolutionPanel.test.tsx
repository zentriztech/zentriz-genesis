import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, { href: string; children: React.ReactNode }>(function Link({ href, children, ...r }, ref) { return <a ref={ref} href={href} {...r}>{children}</a>; });
  return { default: Link };
});
vi.mock("@/lib/api", async (orig) => {
  const real = await orig<typeof import("@/lib/api")>();
  return { ...real, apiGet: vi.fn(), apiPost: vi.fn() };
});
import { ApiError, apiGet, apiPost } from "@/lib/api";
import EvolutionPanel from "./EvolutionPanel";

const get = apiGet as unknown as ReturnType<typeof vi.fn>;
const post = apiPost as unknown as ReturnType<typeof vi.fn>;

const GATES = {
  scope: { status: "failed", detail: "2 arquivo(s) no diff FORA do `files_allowed` do RFC (circuit-breaker.util.ts, pnpm-lock.yaml)." },
  symbols: { status: "passed", detail: "nenhuma remoção registrada nas escritas do Dev" },
  qa: { status: "passed", detail: "QA executado, sem reprovação final registrada" },
  fullTest: { status: "failed", detail: "reprovada: build quebrado (TS2554)" },
  baseline: { status: "not_run", detail: "baseline NÃO medida — sem P2P" },
};
const FILES = ["apps/src/circuit-breaker.util.ts", "apps/pnpm-lock.yaml"];

const baseState = (over: Record<string, unknown> = {}) => ({
  checkpoint: true, checkpointSavedAt: null, scope: ["apps/src/time.controller.ts"], compat: "minor", rfcs: [], request: "GET /time", parentId: null, plan: null,
  touchedFiles: [], violations: {}, violationRounds: {}, completedTasks: [], baseline: null,
  publish: { pending: false, branch: "evolution/v8", repo: "acme/app", prUrl: "https://github.com/acme/app/pull/9", compareUrl: null, version: "1.2.0", supersedes: null, acceptedAt: null, prNumber: 9 },
  merge: { state: null, sha: null, at: null, method: null, actor: null, detail: null, prNumber: 9 },
  factoryGates: GATES, scopeGate: { status: "failed", detail: GATES.scope.detail, files: FILES }, scopeConfirmation: null,
  ...over,
});

function mockLoad(state: Record<string, unknown>) {
  get.mockImplementation(async (url: string) => {
    if (url.endsWith("/evolution-state")) return state;
    if (url.endsWith("/spec-tree")) return { files: [] };
    return { versions: [] };
  });
}
beforeEach(() => { vi.clearAllMocks(); });

describe("EvolutionPanel — gates da fábrica (5) e escopo violado", () => {
  it("mostra os 5 gates com o resultado real e a lista de arquivos fora do escopo", async () => {
    mockLoad(baseState());
    render(<EvolutionPanel projectId="p1" />);
    const list = await screen.findByRole("list", { name: "Gates da fábrica" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    expect(list).toHaveTextContent("Escopo (RFC files_allowed): FALHOU");
    expect(list).toHaveTextContent("TSK-FULL-TEST (e2e): FALHOU");
    expect(list).toHaveTextContent("build quebrado (TS2554)");
    expect(list).toHaveTextContent("Baseline / não-regressão (P2P): não executado / sem evidência");
    expect(list).toHaveTextContent("QA: passou");
    const files = screen.getByRole("list", { name: "Arquivos fora do escopo" });
    expect(files).toHaveTextContent("apps/src/circuit-breaker.util.ts");
    expect(files).toHaveTextContent("apps/pnpm-lock.yaml");
  });

  it("escopo violado: confirmação DUPLA — o botão só habilita com a ciência, MERGE e OUT_OF_SCOPE; envia confirm + confirmScope + reason", async () => {
    mockLoad(baseState());
    post.mockResolvedValue({ ok: true, state: "merged", detail: null });
    render(<EvolutionPanel projectId="p1" />);
    const btn = await screen.findByRole("button", { name: "Mergear mesmo fora do escopo" });
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Confirmação do merge, digite MERGE"), "MERGE");
    expect(btn).toBeDisabled();                                   // falta o escopo e a ciência
    await userEvent.type(screen.getByLabelText("Confirmação de escopo, digite OUT_OF_SCOPE"), "OUT_OF_SCOPE");
    expect(btn).toBeDisabled();                                   // falta a ciência
    await userEvent.click(screen.getByRole("checkbox", { name: /Revisei o diff/ }));
    expect(btn).toBeEnabled();
    await userEvent.type(screen.getByLabelText("Motivo (opcional)"), "revisei o diff");
    await userEvent.click(btn);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/api/projects/p1/evolution/merge", { confirm: "MERGE", confirmScope: "OUT_OF_SCOPE", reason: "revisei o diff" });
  });

  it("MERGE sozinho não basta: sem OUT_OF_SCOPE o botão continua desabilitado", async () => {
    mockLoad(baseState());
    render(<EvolutionPanel projectId="p1" />);
    await userEvent.type(await screen.findByLabelText("Confirmação do merge, digite MERGE"), "MERGE");
    await userEvent.click(screen.getByRole("checkbox", { name: /Revisei o diff/ }));
    expect(screen.getByRole("button", { name: "Mergear mesmo fora do escopo" })).toBeDisabled();
  });

  it("veredito não gravado: o 400 CONFIRM_REQUIRED (blocked_scope) faz aparecer a confirmação dupla com os arquivos da resposta", async () => {
    mockLoad(baseState({ scopeGate: null }));
    post.mockRejectedValueOnce(new ApiError("Esta evolução exige confirmação de escopo: 1 arquivo(s) FORA", 400, "CONFIRM_REQUIRED",
      { code: "CONFIRM_REQUIRED", state: "blocked_scope", detail: "1 arquivo(s) FORA do files_allowed", files: ["apps/src/x.ts"] }));
    render(<EvolutionPanel projectId="p1" />);
    expect(screen.queryByTestId("scope-confirm")).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Mergear agora" }));
    const box = await screen.findByTestId("scope-confirm");
    expect(box).toHaveTextContent("Escopo violado");
    expect(within(box).getByRole("list", { name: "Arquivos fora do escopo" })).toHaveTextContent("apps/src/x.ts");
    expect(screen.getByRole("button", { name: "Mergear mesmo fora do escopo" })).toBeDisabled();
  });

  it("estado blocked_scope tem rótulo próprio e a confirmação já registrada é exibida (quem, quando, motivo)", async () => {
    mockLoad(baseState({
      merge: { state: "blocked_scope", sha: null, at: null, method: null, actor: null, detail: "2 arquivo(s) FORA", prNumber: 9,
        confirmation: { by_email: "ana@t.test", at: "2026-11-04T12:00:00Z", risk: "há regressões no PASS_TO_PASS", reason: "ok" } },
      scopeConfirmation: { by_email: "ana@t.test", at: "2026-11-04T12:00:00Z", reason: "revisei" },
    }));
    render(<EvolutionPanel projectId="p1" />);
    expect(await screen.findByText("Escopo violado — exige confirmação dupla")).toBeInTheDocument();
    const rec = screen.getByTestId("merge-confirmations");
    expect(rec).toHaveTextContent("Merge confirmado por ana@t.test");
    expect(rec).toHaveTextContent("há regressões no PASS_TO_PASS");
    expect(rec).toHaveTextContent("Escopo violado confirmado por ana@t.test");
    expect(rec).toHaveTextContent("motivo: revisei");
  });

  it("escopo íntegro: nada de confirmação dupla e o botão continua 'Mergear agora' (fluxo anterior intacto)", async () => {
    mockLoad(baseState({ scopeGate: { status: "passed", detail: "ok" }, factoryGates: { ...GATES, scope: { status: "passed", detail: "dentro do escopo" } } }));
    post.mockResolvedValue({ ok: true, state: "merged", detail: null });
    render(<EvolutionPanel projectId="p1" />);
    const btn = await screen.findByRole("button", { name: "Mergear agora" });
    expect(screen.queryByTestId("scope-confirm")).not.toBeInTheDocument();
    await userEvent.click(btn);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/projects/p1/evolution/merge", {}));
  });
});
