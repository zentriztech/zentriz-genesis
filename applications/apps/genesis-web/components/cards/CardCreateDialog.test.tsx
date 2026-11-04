import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import { makeCard } from "@/lib/cards/cardFixtures";

vi.mock("@/lib/cards/cardsApi", () => ({ cardsApi: { create: vi.fn() } }));
import { cardsApi } from "@/lib/cards/cardsApi";
import { CardCreateDialog } from "./CardCreateDialog";
const create = cardsApi.create as unknown as ReturnType<typeof vi.fn>;

const setup = (caps: Parameters<typeof CardCreateDialog>[0]["caps"] = { cardsBancada: true }) => {
  const onCreated = vi.fn(); const onClose = vi.fn();
  render(<CardCreateDialog open productId="p1" caps={caps} onClose={onClose} onCreated={onCreated} />);
  return { onCreated, onClose };
};
beforeEach(() => vi.clearAllMocks());

describe("CardCreateDialog", () => {
  it("oferece os 3 tipos com descrição e o modo de trabalho FIXO em branch git (sem seletor)", () => {
    setup();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    for (const k of ["Evolução", "Correção", "Recurso novo"]) expect(screen.getByRole("radio", { name: new RegExp(k) })).toBeInTheDocument();
    expect(screen.getByText(/Modo de trabalho: Branch git\./)).toBeInTheDocument();
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

  it("anexos: lista tipos e teto; recusa extensão fora da lista; aceita pdf/md; permite remover", async () => {
    setup({ cardsBancada: true, attachments: { allowedExtensions: ["pdf", "txt", "md", "doc", "docx"], maxFiles: 3, maxTotalBytes: 5 * 1024 * 1024 } });
    expect(screen.getByText(/Tipos permitidos: pdf, txt, md, doc, docx · até 3 arquivo\(s\) · teto total 5 MB/)).toBeInTheDocument();
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

  it("anexos acima do teto são recusados com mensagem clara", async () => {
    setup({ cardsBancada: true, attachments: { allowedExtensions: ["md"], maxTotalBytes: 2048 } });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File([new Uint8Array(4096)], "grande.md"));
    expect(await screen.findByRole("alert")).toHaveTextContent("passa do teto de 2 KB");
  });

  it("orçamento: mostra saldo livre e mínimo; avisa quando o saldo está abaixo", () => {
    setup({ cardsBancada: true, budget: { freeUsd: 2, minFreeUsd: 5 } });
    expect(screen.getByText(/Saldo livre: US\$ 2\.00 · mínimo exigido para promover: US\$ 5\.00/)).toBeInTheDocument();
    expect(screen.getByText(/saldo está abaixo do mínimo/)).toBeInTheDocument();
  });

  it("mostra a mensagem do backend traduzida: produto não fabricado, anexo recusado e GitHub", async () => {
    setup();
    const user = userEvent.setup();
    fireEvent.change(screen.getByLabelText(/Descrição do pedido/), { target: { value: "algo" } });
    create.mockRejectedValueOnce(new ApiError("x", 409, "NO_ACCEPTED_HEAD"));
    await user.click(screen.getByRole("button", { name: "Criar card" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ainda não foi fabricado e aceito");
    create.mockRejectedValueOnce(new ApiError("x", 400, "ATTACHMENT_INVALID", { errors: ["a.exe: tipo não permitido"] }));
    await user.click(screen.getByRole("button", { name: "Criar card" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("a.exe: tipo não permitido"));
    create.mockRejectedValueOnce(new ApiError("GitHub App não instalado no repositório", 422, "CODE_BASE_UNAVAILABLE"));
    await user.click(screen.getByRole("button", { name: "Criar card" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Confira a instalação do GitHub App"));
  });
});
