"use client";

import { makeAutoObservable, runInAction } from "mobx";
import { apiGet, apiPost, apiPatch, apiDelete, withQuery } from "@/lib/api";

// ── Tipos (RFC-0002 Parte B — Módulo Financeiro F1) ─────────────────────────
export type BankAccount = {
  id: string;
  label: string;
  bankName: string;
  bankCode: string | null;
  agency: string | null;
  account: string | null;
  accountType: "checking" | "savings" | null;
  pixKey: string | null;
  pixKeyType: string | null;
  holderName: string | null;
  holderDocument: string | null;
  isDefault: boolean;
  active: boolean;
  createdAt: string;
};

export type ChargeStatus =
  | "draft" | "open" | "paid" | "partially_paid" | "overdue" | "canceled" | "refunded";
export type ChargeKind = "subscription" | "one_off" | "proration";

export type Charge = {
  id: string;
  tenantId: string;
  tenantName?: string;
  planId: string | null;
  amountCents: number;
  currency: string;
  description: string | null;
  competenceMonth: string | null;
  kind: ChargeKind;
  dueDate: string | null;
  status: ChargeStatus;
  issuedAt: string | null;
  paidAt: string | null;
  paymentMethod: string | null;
  externalId: string | null;
  paidCents?: number;
  createdAt: string;
};

export type Payment = {
  id: string;
  chargeId: string;
  tenantId: string;
  amountCents: number;
  method: string;
  receivedAt: string;
  bankAccountId: string | null;
  externalId: string | null;
  reference: string | null;
  notes: string | null;
  createdAt: string;
};

export type InvoiceStatus = "issued" | "canceled";
export type Invoice = {
  id: string;
  number?: number;
  tenantId: string;
  tenantName?: string;
  chargeId: string | null;
  amountCents: number;
  currency: string;
  description: string | null;
  competenceMonth: string | null;
  status: InvoiceStatus;
  provider: string;
  providerRef: string | null;
  issuedAt: string;
  canceledAt: string | null;
  createdAt: string;
};

export type FinanceSummary = {
  currency: string;
  mrrCents: number;
  openCents: number;
  openCount: number;
  overdueCents: number;
  overdueCount: number;
  receivedThisMonthCents: number;
  receivedThisMonthCount: number;
};

export type CreateChargePayload = {
  tenantId: string;
  amountCents: number;
  kind?: ChargeKind;
  competenceMonth?: string;
  dueDate?: string;
  description?: string;
};

export type CreatePaymentPayload = {
  chargeId: string;
  amountCents: number;
  method: string;
  receivedAt?: string;
  bankAccountId?: string;
  reference?: string;
  notes?: string;
};

class FinanceStore {
  summary: FinanceSummary | null = null;
  charges: Charge[] = [];
  payments: Payment[] = [];
  bankAccounts: BankAccount[] = [];
  invoices: Invoice[] = [];
  loading = false;
  error: string | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  private async guard<T>(fn: () => Promise<T>, msg: string): Promise<T | null> {
    this.loading = true;
    this.error = null;
    try {
      return await fn();
    } catch (err) {
      runInAction(() => { this.error = err instanceof Error ? err.message : msg; });
      return null;
    } finally {
      runInAction(() => { this.loading = false; });
    }
  }

  async loadSummary() {
    const data = await this.guard(() => apiGet<FinanceSummary>("/api/finance/summary"), "Erro ao carregar sumário");
    if (data) runInAction(() => { this.summary = data; });
  }

  async loadCharges(filters?: { tenantId?: string; status?: string; competence?: string }) {
    const data = await this.guard(
      () => apiGet<Charge[]>(withQuery("/api/finance/charges", filters ?? {})),
      "Erro ao carregar cobranças",
    );
    if (data) runInAction(() => { this.charges = data; });
  }

  async loadPayments(filters?: { tenantId?: string; chargeId?: string }) {
    const data = await this.guard(
      () => apiGet<Payment[]>(withQuery("/api/finance/payments", filters ?? {})),
      "Erro ao carregar pagamentos",
    );
    if (data) runInAction(() => { this.payments = data; });
  }

  async loadBankAccounts() {
    const data = await this.guard(() => apiGet<BankAccount[]>("/api/finance/bank-accounts"), "Erro ao carregar contas");
    if (data) runInAction(() => { this.bankAccounts = data; });
  }

  async createBankAccount(payload: Partial<BankAccount>): Promise<BankAccount | null> {
    const created = await apiPost<BankAccount>("/api/finance/bank-accounts", payload);
    runInAction(() => { this.bankAccounts.unshift(created); });
    return created;
  }

  async updateBankAccount(id: string, payload: Partial<BankAccount>): Promise<void> {
    const updated = await apiPatch<BankAccount>(`/api/finance/bank-accounts/${id}`, payload);
    await this.loadBankAccounts();
    void updated;
  }

  async deleteBankAccount(id: string): Promise<void> {
    await apiDelete(`/api/finance/bank-accounts/${id}`);
    await this.loadBankAccounts();
  }

  async createCharge(payload: CreateChargePayload): Promise<Charge> {
    const created = await apiPost<Charge>("/api/finance/charges", payload);
    runInAction(() => { this.charges.unshift(created); });
    return created;
  }

  async generateMonth(competence: string): Promise<{ created: number; skipped: number; eligible: number }> {
    const res = await apiPost<{ created: number; skipped: number; eligible: number }>(
      "/api/finance/charges/generate-month", { competence },
    );
    await this.loadCharges();
    return res;
  }

  async cancelCharge(id: string): Promise<void> {
    await apiPatch(`/api/finance/charges/${id}`, { status: "canceled" });
    await this.loadCharges();
  }

  async createPayment(payload: CreatePaymentPayload): Promise<void> {
    await apiPost("/api/finance/payments", payload);
    await Promise.all([this.loadCharges(), this.loadSummary()]);
  }

  // ── Notas fiscais (F3 — MVP interno) ──────────────────────────────────────
  async loadInvoices(filters?: { tenantId?: string; status?: string; competence?: string }) {
    const data = await this.guard(
      () => apiGet<Invoice[]>(withQuery("/api/finance/invoices", filters ?? {})),
      "Erro ao carregar notas fiscais",
    );
    if (data) runInAction(() => { this.invoices = data; });
  }

  /** Emite uma nota a partir de uma cobrança PAGA (o backend deriva valor/tenant/competência). */
  async issueInvoice(chargeId: string): Promise<Invoice> {
    const created = await apiPost<Invoice>("/api/finance/invoices", { chargeId });
    runInAction(() => { this.invoices.unshift(created); });
    return created;
  }

  async cancelInvoice(id: string): Promise<void> {
    await apiPost(`/api/finance/invoices/${id}/cancel`, {});
    await this.loadInvoices();
  }
}

export const financeStore = new FinanceStore();
