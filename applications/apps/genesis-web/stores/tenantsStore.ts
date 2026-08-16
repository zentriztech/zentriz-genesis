"use client";

import { makeAutoObservable, runInAction } from "mobx";
import type { Tenant, TenantStatus } from "@/types";
import { apiGet, apiPost, apiPatch } from "@/lib/api";

export type CreateTenantPayload = {
  name: string;
  planId: string;
  status?: TenantStatus;
};

export type UpdateTenantPayload = {
  name?: string;
  planId?: string;
  status?: TenantStatus;
};

/**
 * Governança de tenants (só master / zentriz_admin). Lista com contadores de uso,
 * cria, e atualiza nome/plano/status. Desativar um tenant (status != 'active')
 * bloqueia o login de todos os seus usuários no backend (auth.ts).
 */
class TenantsStore {
  tenants: Tenant[] = [];
  loading = false;
  error: string | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  async load() {
    this.loading = true;
    this.error = null;
    try {
      const data = await apiGet<Tenant[]>("/api/tenants");
      runInAction(() => {
        this.tenants = Array.isArray(data) ? data : [];
      });
    } catch (err) {
      runInAction(() => {
        this.error = err instanceof Error ? err.message : "Erro ao carregar tenants";
      });
    } finally {
      runInAction(() => {
        this.loading = false;
      });
    }
  }

  getById(id: string | null | undefined): Tenant | null {
    if (!id) return null;
    return this.tenants.find((t) => t.id === id) ?? null;
  }

  async create(payload: CreateTenantPayload): Promise<Tenant> {
    const created = await apiPost<Tenant>("/api/tenants", payload);
    await this.load();
    return created;
  }

  async update(id: string, payload: UpdateTenantPayload): Promise<Tenant> {
    const updated = await apiPatch<Tenant>(`/api/tenants/${id}`, payload);
    runInAction(() => {
      const idx = this.tenants.findIndex((t) => t.id === id);
      if (idx !== -1) this.tenants[idx] = { ...this.tenants[idx], ...updated };
    });
    // O PATCH devolve planId mas não o objeto `plan` aninhado (nem contadores). Se o plano
    // mudou, recarrega para não exibir nome de plano/uso obsoletos na tabela.
    if (payload.planId !== undefined) await this.load();
    return updated;
  }

  async setStatus(id: string, status: TenantStatus): Promise<Tenant> {
    return this.update(id, { status });
  }
}

export const tenantsStore = new TenantsStore();
