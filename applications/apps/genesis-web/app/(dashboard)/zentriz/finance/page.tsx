"use client";

import { useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react-lite";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import PaymentsIcon from "@mui/icons-material/Payments";
import CancelIcon from "@mui/icons-material/Cancel";
import StarIcon from "@mui/icons-material/Star";
import DeleteIcon from "@mui/icons-material/Delete";
import ReceiptLongIcon from "@mui/icons-material/ReceiptLong";
import { authStore } from "@/stores/authStore";
import { tenantsStore } from "@/stores/tenantsStore";
import {
  financeStore, type Charge, type ChargeStatus, type BankAccount, type InvoiceStatus,
} from "@/stores/financeStore";

// ── Helpers ──────────────────────────────────────────────────────────────
function formatBRL(cents: number | undefined): string {
  return ((cents ?? 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function parseReaisToCents(input: string): number | null {
  const normalized = input.trim().replace(/\./g, "").replace(",", ".");
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}
function currentCompetence(): string {
  // Competência no fuso America/Sao_Paulo (L1), independente do fuso do navegador.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${y}-${m}`;
}
const STATUS_COLOR: Record<ChargeStatus, "default" | "success" | "warning" | "error" | "info"> = {
  draft: "default", open: "info", paid: "success", partially_paid: "warning",
  overdue: "error", canceled: "default", refunded: "default",
};
const STATUS_LABEL: Record<ChargeStatus, string> = {
  draft: "Rascunho", open: "Em aberto", paid: "Paga", partially_paid: "Parcial",
  overdue: "Vencida", canceled: "Cancelada", refunded: "Estornada",
};
const PAYMENT_METHODS = [
  { v: "pix", l: "PIX" }, { v: "boleto", l: "Boleto" }, { v: "card", l: "Cartão" },
  { v: "transfer", l: "Transferência" }, { v: "cash", l: "Dinheiro" }, { v: "manual", l: "Manual" },
];
const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = { issued: "Emitida", canceled: "Cancelada" };
const INVOICE_STATUS_COLOR: Record<InvoiceStatus, "success" | "default"> = { issued: "success", canceled: "default" };

// ═══════════════ Diálogo: nova cobrança ═══════════════
function NewChargeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tenantId, setTenantId] = useState("");
  const [kind, setKind] = useState<"one_off" | "subscription">("one_off");
  const [amount, setAmount] = useState("");
  const [competence, setCompetence] = useState(currentCompetence());
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    const cents = parseReaisToCents(amount);
    if (!tenantId) return setErr("Selecione o tenant");
    if (cents === null) return setErr("Valor inválido");
    setSaving(true); setErr(null);
    try {
      await financeStore.createCharge({
        tenantId, amountCents: cents, kind,
        competenceMonth: kind === "subscription" ? competence : undefined,
        description: description.trim() || undefined,
      });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Erro ao criar cobrança");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Nova cobrança</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {err && <Alert severity="error">{err}</Alert>}
          <TextField select label="Tenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)} fullWidth>
            {tenantsStore.tenants.map((t) => (
              <MenuItem key={t.id} value={t.id}>{t.name}</MenuItem>
            ))}
          </TextField>
          <TextField select label="Tipo" value={kind} onChange={(e) => setKind(e.target.value as "one_off" | "subscription")} fullWidth>
            <MenuItem value="one_off">Avulsa</MenuItem>
            <MenuItem value="subscription">Assinatura (mensal)</MenuItem>
          </TextField>
          {kind === "subscription" && (
            <TextField label="Competência (YYYY-MM)" value={competence} onChange={(e) => setCompetence(e.target.value)} fullWidth />
          )}
          <TextField label="Valor (R$)" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" fullWidth />
          <TextField label="Descrição" value={description} onChange={(e) => setDescription(e.target.value)} fullWidth multiline minRows={2} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button variant="contained" onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Criar"}</Button>
      </DialogActions>
    </Dialog>
  );
}

// ═══════════════ Diálogo: registrar pagamento ═══════════════
function PaymentDialog({ charge, open, onClose }: { charge: Charge | null; open: boolean; onClose: () => void }) {
  const remaining = charge ? Math.max(0, charge.amountCents - (charge.paidCents ?? 0)) : 0;
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("pix");
  const [bankAccountId, setBankAccountId] = useState("");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open && charge) {
      setAmount(((remaining || charge.amountCents) / 100).toFixed(2).replace(".", ","));
      setErr(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, charge?.id]);

  const submit = async () => {
    if (!charge) return;
    const cents = parseReaisToCents(amount);
    if (cents === null || cents <= 0) return setErr("Valor inválido");
    setSaving(true); setErr(null);
    try {
      await financeStore.createPayment({
        chargeId: charge.id, amountCents: cents, method,
        bankAccountId: bankAccountId || undefined, reference: reference.trim() || undefined,
      });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Erro ao registrar pagamento");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Registrar pagamento</DialogTitle>
      <DialogContent>
        {charge && (
          <Stack spacing={2} sx={{ mt: 1 }}>
            {err && <Alert severity="error">{err}</Alert>}
            <Typography variant="body2" color="text.secondary">
              {charge.tenantName} · Total {formatBRL(charge.amountCents)} · Pago {formatBRL(charge.paidCents)} · Restante {formatBRL(remaining)}
            </Typography>
            <TextField label="Valor recebido (R$)" value={amount} onChange={(e) => setAmount(e.target.value)} fullWidth />
            <TextField select label="Método" value={method} onChange={(e) => setMethod(e.target.value)} fullWidth>
              {PAYMENT_METHODS.map((m) => <MenuItem key={m.v} value={m.v}>{m.l}</MenuItem>)}
            </TextField>
            <TextField select label="Conta recebedora (opcional)" value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} fullWidth>
              <MenuItem value="">—</MenuItem>
              {financeStore.bankAccounts.filter((b) => b.active).map((b) => (
                <MenuItem key={b.id} value={b.id}>{b.label} · {b.bankName}</MenuItem>
              ))}
            </TextField>
            <TextField label="Referência (opcional)" value={reference} onChange={(e) => setReference(e.target.value)} fullWidth />
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button variant="contained" onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Confirmar"}</Button>
      </DialogActions>
    </Dialog>
  );
}

// ═══════════════ Diálogo: nova conta bancária ═══════════════
function NewBankAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [f, setF] = useState({ label: "", bankName: "", bankCode: "", agency: "", account: "", pixKey: "", holderName: "", isDefault: false });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: string | boolean) => setF((prev) => ({ ...prev, [k]: v }));

  const submit = async () => {
    if (!f.label.trim() || !f.bankName.trim()) return setErr("Rótulo e banco são obrigatórios");
    setSaving(true); setErr(null);
    try {
      await financeStore.createBankAccount({
        label: f.label.trim(), bankName: f.bankName.trim(),
        bankCode: f.bankCode.trim() || undefined, agency: f.agency.trim() || undefined,
        account: f.account.trim() || undefined, pixKey: f.pixKey.trim() || undefined,
        holderName: f.holderName.trim() || undefined, isDefault: f.isDefault,
      } as Partial<BankAccount>);
      setF({ label: "", bankName: "", bankCode: "", agency: "", account: "", pixKey: "", holderName: "", isDefault: false });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Erro ao criar conta");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Nova conta bancária</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {err && <Alert severity="error">{err}</Alert>}
          <TextField label="Rótulo" value={f.label} onChange={(e) => set("label", e.target.value)} fullWidth />
          <TextField label="Banco" value={f.bankName} onChange={(e) => set("bankName", e.target.value)} fullWidth />
          <Stack direction="row" spacing={2}>
            <TextField label="Código" value={f.bankCode} onChange={(e) => set("bankCode", e.target.value)} fullWidth />
            <TextField label="Agência" value={f.agency} onChange={(e) => set("agency", e.target.value)} fullWidth />
            <TextField label="Conta" value={f.account} onChange={(e) => set("account", e.target.value)} fullWidth />
          </Stack>
          <TextField label="Chave PIX" value={f.pixKey} onChange={(e) => set("pixKey", e.target.value)} fullWidth />
          <TextField label="Titular" value={f.holderName} onChange={(e) => set("holderName", e.target.value)} fullWidth />
          <TextField select label="Conta padrão?" value={f.isDefault ? "1" : "0"} onChange={(e) => set("isDefault", e.target.value === "1")} fullWidth>
            <MenuItem value="0">Não</MenuItem>
            <MenuItem value="1">Sim</MenuItem>
          </TextField>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button variant="contained" onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Criar"}</Button>
      </DialogActions>
    </Dialog>
  );
}

// ═══════════════ Página ═══════════════
function FinancePage() {
  const [tab, setTab] = useState(0);
  const [newCharge, setNewCharge] = useState(false);
  const [newBank, setNewBank] = useState(false);
  const [payFor, setPayFor] = useState<Charge | null>(null);
  const [genCompetence, setGenCompetence] = useState(currentCompetence());
  const [genMsg, setGenMsg] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [noteMsg, setNoteMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!authStore.isZentrizAdmin) return;
    void financeStore.loadSummary();
    void financeStore.loadCharges();
    void financeStore.loadBankAccounts();
    void tenantsStore.load();
  }, []);

  const s = financeStore.summary;
  const filteredCharges = useMemo(
    () => financeStore.charges.filter((c) => !statusFilter || c.status === statusFilter),
    [financeStore.charges, statusFilter],
  );

  if (!authStore.isZentrizAdmin) {
    return <Alert severity="warning" sx={{ m: 3 }}>Acesso restrito à conta de gestão Zentriz.</Alert>;
  }

  const issueInvoice = async (chargeId: string) => {
    setNoteMsg(null);
    try {
      await financeStore.issueInvoice(chargeId);
      setTab(3);
      await financeStore.loadInvoices();
      setNoteMsg("Nota fiscal emitida com sucesso.");
    } catch (e) {
      setNoteMsg(e instanceof Error ? e.message : "Erro ao emitir nota fiscal");
    }
  };

  const runGenerate = async () => {
    setGenMsg(null);
    try {
      const r = await financeStore.generateMonth(genCompetence);
      setGenMsg(`Competência ${genCompetence}: ${r.created} criada(s), ${r.skipped} já existente(s), ${r.eligible} elegível(is).`);
      void financeStore.loadSummary();
    } catch (e) {
      setGenMsg(e instanceof Error ? e.message : "Erro ao gerar cobranças");
    }
  };

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      <Typography variant="h4" fontWeight={700} gutterBottom>Financeiro</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Contas bancárias, cobranças e pagamentos dos tenants. Valores em BRL.
      </Typography>

      {financeStore.error && <Alert severity="error" sx={{ mb: 2 }}>{financeStore.error}</Alert>}
      {noteMsg && <Alert severity="info" sx={{ mb: 2 }} onClose={() => setNoteMsg(null)}>{noteMsg}</Alert>}

      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 2 }} variant="scrollable" scrollButtons="auto">
        <Tab label="Resumo" />
        <Tab label="Cobranças" />
        <Tab label="Pagamentos" onClick={() => void financeStore.loadPayments()} />
        <Tab label="Notas fiscais" onClick={() => void financeStore.loadInvoices()} />
        <Tab label="Contas bancárias" />
      </Tabs>

      {/* ── Resumo ── */}
      {tab === 0 && (
        <Box>
          <Grid container spacing={2}>
            {[
              { label: "MRR (tenants ativos)", value: s?.mrrCents, color: "#22C55E" },
              { label: "Em aberto", value: s?.openCents, sub: `${s?.openCount ?? 0} cobrança(s)`, color: "#0EA5E9" },
              { label: "Vencidas", value: s?.overdueCents, sub: `${s?.overdueCount ?? 0} cobrança(s)`, color: "#EF4444" },
              { label: "Recebido no mês", value: s?.receivedThisMonthCents, sub: `${s?.receivedThisMonthCount ?? 0} pagamento(s)`, color: "#8B5CF6" },
            ].map((k) => (
              <Grid key={k.label} size={{ xs: 12, sm: 6, md: 3 }}>
                <Card sx={{ borderLeft: `4px solid ${k.color}` }}>
                  <CardContent>
                    <Typography variant="caption" color="text.secondary">{k.label}</Typography>
                    <Typography variant="h5" fontWeight={700}>{formatBRL(k.value)}</Typography>
                    {k.sub && <Typography variant="caption" color="text.secondary">{k.sub}</Typography>}
                  </CardContent>
                </Card>
              </Grid>
            ))}
          </Grid>

          <Card sx={{ mt: 3 }}>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={600} gutterBottom>Gerar cobranças do mês</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Cria a cobrança de assinatura da competência para cada tenant com plano pago (idempotente).
              </Typography>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ sm: "center" }}>
                <TextField label="Competência (YYYY-MM)" value={genCompetence} onChange={(e) => setGenCompetence(e.target.value)} size="small" />
                <Button variant="contained" onClick={runGenerate}>Gerar</Button>
              </Stack>
              {genMsg && <Alert severity="info" sx={{ mt: 2 }}>{genMsg}</Alert>}
            </CardContent>
          </Card>
        </Box>
      )}

      {/* ── Cobranças ── */}
      {tab === 1 && (
        <Box>
          <Stack direction="row" spacing={2} sx={{ mb: 2 }} alignItems="center" flexWrap="wrap">
            <Button variant="contained" onClick={() => setNewCharge(true)}>Nova cobrança</Button>
            <TextField select label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} size="small" sx={{ minWidth: 160 }}>
              <MenuItem value="">Todos</MenuItem>
              {(Object.keys(STATUS_LABEL) as ChargeStatus[]).map((k) => (
                <MenuItem key={k} value={k}>{STATUS_LABEL[k]}</MenuItem>
              ))}
            </TextField>
          </Stack>
          {financeStore.loading && <CircularProgress size={22} />}
          <Card>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Tenant</TableCell>
                  <TableCell>Competência</TableCell>
                  <TableCell>Tipo</TableCell>
                  <TableCell align="right">Valor</TableCell>
                  <TableCell align="right">Pago</TableCell>
                  <TableCell>Vencimento</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell align="right">Ações</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredCharges.map((c) => (
                  <TableRow key={c.id} hover>
                    <TableCell>{c.tenantName}</TableCell>
                    <TableCell>{c.competenceMonth ?? "—"}</TableCell>
                    <TableCell>{c.kind === "subscription" ? "Assinatura" : c.kind === "proration" ? "Pró-rata" : "Avulsa"}</TableCell>
                    <TableCell align="right">{formatBRL(c.amountCents)}</TableCell>
                    <TableCell align="right">{formatBRL(c.paidCents)}</TableCell>
                    <TableCell>{c.dueDate ?? "—"}</TableCell>
                    <TableCell><Chip size="small" label={STATUS_LABEL[c.status]} color={STATUS_COLOR[c.status]} /></TableCell>
                    <TableCell align="right">
                      {c.status !== "paid" && c.status !== "canceled" && (
                        <Tooltip title="Registrar pagamento">
                          <IconButton size="small" color="success" onClick={() => setPayFor(c)}><PaymentsIcon fontSize="small" /></IconButton>
                        </Tooltip>
                      )}
                      {c.status !== "paid" && c.status !== "partially_paid" && c.status !== "canceled" && (
                        <Tooltip title="Cancelar">
                          <IconButton size="small" color="error" onClick={() => void financeStore.cancelCharge(c.id)}><CancelIcon fontSize="small" /></IconButton>
                        </Tooltip>
                      )}
                      {c.status === "paid" && (
                        <Tooltip title="Emitir nota fiscal">
                          <IconButton size="small" color="primary" onClick={() => void issueInvoice(c.id)}><ReceiptLongIcon fontSize="small" /></IconButton>
                        </Tooltip>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {filteredCharges.length === 0 && (
                  <TableRow><TableCell colSpan={8} align="center"><Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>Nenhuma cobrança.</Typography></TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        </Box>
      )}

      {/* ── Pagamentos ── */}
      {tab === 2 && (
        <Card>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Recebido em</TableCell>
                <TableCell>Cobrança</TableCell>
                <TableCell>Método</TableCell>
                <TableCell align="right">Valor</TableCell>
                <TableCell>Referência</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {financeStore.payments.map((p) => (
                <TableRow key={p.id} hover>
                  <TableCell>{new Date(p.receivedAt).toLocaleString("pt-BR")}</TableCell>
                  <TableCell>{p.chargeId.slice(0, 8)}</TableCell>
                  <TableCell>{p.method}</TableCell>
                  <TableCell align="right">{formatBRL(p.amountCents)}</TableCell>
                  <TableCell>{p.reference ?? "—"}</TableCell>
                </TableRow>
              ))}
              {financeStore.payments.length === 0 && (
                <TableRow><TableCell colSpan={5} align="center"><Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>Nenhum pagamento registrado.</Typography></TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* ── Notas fiscais ── */}
      {tab === 3 && (
        <Box>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Notas internas geradas a partir de cobranças pagas. Emissão pela aba Cobranças (ação
            &ldquo;Emitir nota fiscal&rdquo; em cobranças quitadas). Sem integração com NFS-e municipal nesta fase.
          </Typography>
          {financeStore.loading && <CircularProgress size={22} />}
          <Card>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Número</TableCell>
                  <TableCell>Tenant</TableCell>
                  <TableCell>Competência</TableCell>
                  <TableCell align="right">Valor</TableCell>
                  <TableCell>Referência</TableCell>
                  <TableCell>Emitida em</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell align="right">Ações</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {financeStore.invoices.map((inv) => (
                  <TableRow key={inv.id} hover>
                    <TableCell>{inv.number != null ? String(inv.number).padStart(6, "0") : "—"}</TableCell>
                    <TableCell>{inv.tenantName ?? "—"}</TableCell>
                    <TableCell>{inv.competenceMonth ?? "—"}</TableCell>
                    <TableCell align="right">{formatBRL(inv.amountCents)}</TableCell>
                    <TableCell>{inv.providerRef ?? "—"}</TableCell>
                    <TableCell>{new Date(inv.issuedAt).toLocaleString("pt-BR")}</TableCell>
                    <TableCell><Chip size="small" label={INVOICE_STATUS_LABEL[inv.status]} color={INVOICE_STATUS_COLOR[inv.status]} /></TableCell>
                    <TableCell align="right">
                      {inv.status === "issued" && (
                        <Tooltip title="Cancelar nota">
                          <IconButton size="small" color="error" onClick={() => void financeStore.cancelInvoice(inv.id)}><CancelIcon fontSize="small" /></IconButton>
                        </Tooltip>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {financeStore.invoices.length === 0 && (
                  <TableRow><TableCell colSpan={8} align="center"><Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>Nenhuma nota emitida.</Typography></TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        </Box>
      )}

      {/* ── Contas bancárias ── */}
      {tab === 4 && (
        <Box>
          <Button variant="contained" sx={{ mb: 2 }} onClick={() => setNewBank(true)}>Nova conta</Button>
          <Grid container spacing={2}>
            {financeStore.bankAccounts.map((b) => (
              <Grid key={b.id} size={{ xs: 12, sm: 6, md: 4 }}>
                <Card sx={{ opacity: b.active ? 1 : 0.55 }}>
                  <CardContent>
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography variant="subtitle1" fontWeight={600}>{b.label}</Typography>
                      {b.isDefault && <Chip size="small" color="success" icon={<StarIcon />} label="Padrão" />}
                    </Stack>
                    <Typography variant="body2" color="text.secondary">{b.bankName} {b.bankCode ? `(${b.bankCode})` : ""}</Typography>
                    {(b.agency || b.account) && <Typography variant="body2">Ag {b.agency ?? "—"} · Cc {b.account ?? "—"}</Typography>}
                    {b.pixKey && <Typography variant="body2">PIX: {b.pixKey}</Typography>}
                    <Divider sx={{ my: 1 }} />
                    <Stack direction="row" spacing={1}>
                      {!b.isDefault && b.active && (
                        <Button size="small" onClick={() => void financeStore.updateBankAccount(b.id, { isDefault: true })}>Tornar padrão</Button>
                      )}
                      {b.active && (
                        <Button size="small" color="error" startIcon={<DeleteIcon />} onClick={() => void financeStore.deleteBankAccount(b.id)}>Desativar</Button>
                      )}
                    </Stack>
                  </CardContent>
                </Card>
              </Grid>
            ))}
            {financeStore.bankAccounts.length === 0 && (
              <Grid size={{ xs: 12 }}><Typography variant="body2" color="text.secondary">Nenhuma conta cadastrada.</Typography></Grid>
            )}
          </Grid>
        </Box>
      )}

      <NewChargeDialog open={newCharge} onClose={() => setNewCharge(false)} />
      <NewBankAccountDialog open={newBank} onClose={() => setNewBank(false)} />
      <PaymentDialog charge={payFor} open={!!payFor} onClose={() => setPayFor(null)} />
    </Box>
  );
}

export default observer(FinancePage);
