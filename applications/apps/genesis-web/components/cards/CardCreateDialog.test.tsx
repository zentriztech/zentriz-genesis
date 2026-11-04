import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import { makeCard } from "@/lib/cards/cardFixtures";
import { fixture } from "@/lib/cards/contractFixtures";

vi.mock("@/lib/cards/cardsApi", () => ({ cardsApi: { create: vi.fn() } }));
import { cardsApi } from "@/lib/cards/cardsApi";
import { CardCreateDialog } from "./CardCreateDialog";
const create = cardsApi.create as unknown as ReturnType<typeof vi.fn>;

const setup = () => {
  const onCreated = vi.fn(); const onClose = vi.fn();
  render(<CardCreateDialog open productId="p1" onClose={onClose} onCreated={onCreated} />);
  return { onCreated, onClose };
};
beforeEach(() => vi.clearAllMocks());

describe("CardCreateDialog", () => {
  it("oferece os 3 tipos com descrição e explica como o card chega à fábrica (sem seletor de modo)", () => {
    setup();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    for (const k of ["Evolução", "Correção", "Recurso novo"]) expect(screen.getByRole("radio", { name: new RegExp(k) })).toBeInTheDocument();
    expect(screen.getByText(/Como o card chega à fábrica:/)).toBeInTheDocument();
    expect(screen.getByText(/evolution\/vN/)).toBeInTheDocument();
    expect(screen.queryByText(/cópia do projeto|copy/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/modo de trabalho/i)).not.toBeInTheDocument();
  });

  it("exige a descrição do pedido", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Criar card" }));
    expect(screen.getByText(/Descreva o pedido/)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it("envia tipo, título e texto; entrega o card criado", async () => {
    const { onCreated } = setup();
    create.mockResolvedValue(makeCard({ id: "novo", kind: "fix" }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: /Correção/ }));
    await user.type(screen.getByLabelText(/Título/), "Erro no CSV");
    await user.type(screen.getByLabelText(/Descrição do pedido/), "O CSV vem vazio.");
    await user.click(screen.getByRole("button", { name: "Criar card" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "novo" })));
    expect(create).toHaveBeenCalledWith("p1", { kind: "fix", title: "Erro no CSV", body: "O CSV vem vazio.", files: [] });
  });

  it("clique duplo em Criar não cria dois cards", async () => {
    setup();
    let resolve!: (v: unknown) => void;
    create.mockReturnValue(new Promise((r) => { resolve = r; }));
    fireEvent.change(screen.getByLabelText(/Descrição do pedido/), { target: { value: "algo" } });
    const btn = screen.getByRole("button", { name: "Criar card" });
    fireEvent.click(btn); fireEvent.click(btn);
    expect(create).toHaveBeenCalledTimes(1);
    resolve(makeCard());
  });

  it("anexos: lista os tipos do backend (pdf, txt, md, doc, docx); recusa extensão fora da lista; aceita pdf/md; permite remover", async () => {
    setup();
    expect(screen.getByText(/Tipos permitidos: pdf, txt, md, doc, docx · quantidade e tamanho máximos são conferidos pelo servidor/)).toBeInTheDocument();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(input, new File(["x"], "foto.png", { type: "image/png" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("“foto.png”: tipo não permitido");
    await user.upload(input, [new File(["a"], "spec.md"), new File(["b"], "manual.pdf")]);
    expect(await screen.findByText(/spec\.md \(1 KB\)/)).toBeInTheDocument();
    expect(screen.getByText(/manual\.pdf/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remover spec.md" }));
    expect(screen.queryByText(/spec\.md/)).not.toBeInTheDocument();
  });

  it("orçamento: explica que o saldo é conferido pelo servidor (a capacidade real não traz saldo)", () => {
    setup();
    expect(screen.getByText(/O saldo é conferido pelo servidor ao criar, validar e promover/)).toBeInTheDocument();
    expect(screen.queryByText(/Saldo livre: US\$/)).not.toBeInTheDocument();
  });

  it("mostra a mensagem do backend (corpos REAIS): sem orçamento, anexo recusado, anexos indisponíveis e pedido inválido", async () => {
    setup();
    const user = userEvent.setup();
    fireEvent.change(screen.getByLabelText(/Descrição do pedido/), { target: { value: "algo" } });
    const reject = (name: string) => { const f = fixture<Record<string, unknown>>(name); return new ApiError(String(f.body.message), f.status, String(f.body.code), f.body); };
    create.mockRejectedValueOnce(reject("create.402-budget-missing"));
    await user.click(screen.getByRole("button", { name: "Criar card" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A versão corrente não tem orçamento de IA definido");
    create.mockRejectedValueOnce(reject("create.400-attachment-invalid"));
    await user.click(screen.getByRole("button", { name: "Criar card" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Algum anexo não é aceito.*Tipo ".exe" não permitido/));
    create.mockRejectedValueOnce(reject("create.409-attachments-unavailable"));
    await user.click(screen.getByRole("button", { name: "Criar card" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Anexos de card ainda não estão habilitados para este cliente"));
    create.mockRejectedValueOnce(reject("create.400-bad-request"));
    await user.click(screen.getByRole("button", { name: "Criar card" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Descreva o que o card pede"));
  });
});
