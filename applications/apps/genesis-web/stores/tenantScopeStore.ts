"use client";

import { makeAutoObservable } from "mobx";

const STORAGE_KEY = "genesis_selected_tenant";

/**
 * Escopo de tenant selecionado pelo master (zentriz_admin) no seletor do topo.
 * Persistido em localStorage para lembrar a última escolha ao trocar de tela.
 *   - null  → "Todos os tenants" (visão global, sem filtro)
 *   - <id>  → filtra dados daquele tenant
 * Só afeta o master; para tenant_admin/user o backend já escopa pelo próprio tenant.
 */
class TenantScopeStore {
  selectedTenantId: string | null = null;
  hydrated = false;

  constructor() {
    makeAutoObservable(this);
  }

  hydrate() {
    if (typeof window === "undefined" || this.hydrated) return;
    const v = localStorage.getItem(STORAGE_KEY);
    this.selectedTenantId = v && v.length > 0 ? v : null;
    this.hydrated = true;
  }

  setSelected(tenantId: string | null) {
    this.selectedTenantId = tenantId && tenantId.length > 0 ? tenantId : null;
    if (typeof window !== "undefined") {
      if (this.selectedTenantId) localStorage.setItem(STORAGE_KEY, this.selectedTenantId);
      else localStorage.removeItem(STORAGE_KEY);
    }
  }

  /** Valor pronto para query param: string do tenant selecionado, ou null (todos). */
  get effectiveTenantId(): string | null {
    return this.selectedTenantId;
  }

  clear() {
    this.selectedTenantId = null;
    this.hydrated = false;
    if (typeof window !== "undefined") localStorage.removeItem(STORAGE_KEY);
  }
}

export const tenantScopeStore = new TenantScopeStore();
