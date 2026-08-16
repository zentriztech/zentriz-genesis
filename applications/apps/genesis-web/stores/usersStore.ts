"use client";

import { makeAutoObservable, runInAction } from "mobx";
import type { User } from "@/types";
import { apiGet, apiPost, apiPatch, apiDelete, withQuery } from "@/lib/api";
import { tenantScopeStore } from "@/stores/tenantScopeStore";

export type UpdateUserPayload = {
  name?: string;
  email?: string;
  password?: string;
  role?: string;
};

export type CreateUserPayload = {
  email: string;
  name: string;
  password: string;
  role: "user" | "tenant_admin" | "zentriz_admin";
  tenant_id?: string | null;
};

class UsersStore {
  users: User[] = [];
  loading = false;
  error: string | null = null;
  // Latest-wins: troca rápida de escopo não pode aplicar uma resposta obsoleta.
  private reqSeq = 0;

  constructor() {
    makeAutoObservable(this);
  }

  async loadUsers() {
    const seq = ++this.reqSeq;
    this.loading = true;
    this.error = null;
    try {
      // Master: escopa pelo tenant selecionado no topo (null = todos). Backend ignora o
      // param para papeis não-master (já escopados pelo próprio tenant).
      const data = await apiGet<User[]>(
        withQuery("/api/users", { tenantId: tenantScopeStore.effectiveTenantId })
      );
      runInAction(() => {
        if (seq !== this.reqSeq) return; // resposta obsoleta
        this.users = data;
      });
    } catch (err) {
      runInAction(() => {
        if (seq !== this.reqSeq) return;
        this.error = err instanceof Error ? err.message : "Erro ao carregar usuários";
      });
    } finally {
      runInAction(() => {
        if (seq === this.reqSeq) this.loading = false;
      });
    }
  }

  async createUser(payload: CreateUserPayload): Promise<User> {
    const created = await apiPost<User>("/api/users", payload);
    runInAction(() => {
      this.users.unshift(created);
    });
    return created;
  }

  async updateUser(id: string, payload: UpdateUserPayload): Promise<User> {
    const updated = await apiPatch<User>(`/api/users/${id}`, payload);
    runInAction(() => {
      const idx = this.users.findIndex((u) => u.id === id);
      if (idx !== -1) this.users[idx] = updated;
    });
    return updated;
  }

  async deleteUser(id: string): Promise<void> {
    await apiDelete(`/api/users/${id}`);
    runInAction(() => {
      this.users = this.users.filter((u) => u.id !== id);
    });
  }
}

export const usersStore = new UsersStore();
