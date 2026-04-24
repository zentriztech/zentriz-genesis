"use client";

import { makeAutoObservable, runInAction } from "mobx";
import type { Plan } from "@/types";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/lib/api";

export type CreatePlanPayload = {
  id: string;
  name: string;
  slug: string;
  maxProjects: number;
  maxUsersPerTenant: number;
};

export type UpdatePlanPayload = {
  name?: string;
  maxProjects?: number;
  maxUsersPerTenant?: number;
};

class PlansStore {
  plans: Plan[] = [];
  loading = false;
  error: string | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  async load() {
    this.loading = true;
    this.error = null;
    try {
      const data = await apiGet<Plan[]>("/api/plans");
      runInAction(() => {
        this.plans = data;
      });
    } catch (err) {
      runInAction(() => {
        this.error = err instanceof Error ? err.message : "Erro ao carregar planos";
      });
    } finally {
      runInAction(() => {
        this.loading = false;
      });
    }
  }

  async create(payload: CreatePlanPayload): Promise<Plan> {
    const created = await apiPost<Plan>("/api/plans", payload);
    runInAction(() => {
      this.plans.push(created);
      this.plans.sort((a, b) => a.maxProjects - b.maxProjects);
    });
    return created;
  }

  async update(id: string, payload: UpdatePlanPayload): Promise<Plan> {
    const updated = await apiPatch<Plan>(`/api/plans/${id}`, payload);
    runInAction(() => {
      const idx = this.plans.findIndex((p) => p.id === id);
      if (idx !== -1) this.plans[idx] = updated;
    });
    return updated;
  }

  async remove(id: string): Promise<void> {
    await apiDelete(`/api/plans/${id}`);
    runInAction(() => {
      this.plans = this.plans.filter((p) => p.id !== id);
    });
  }
}

export const plansStore = new PlansStore();
