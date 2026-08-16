"use client";

import { makeAutoObservable } from "mobx";
import type { Project } from "@/types";
import { apiGet, withQuery } from "@/lib/api";
import { tenantScopeStore } from "@/stores/tenantScopeStore";

class ProjectsStore {
  list: Project[] = [];
  loading = false;
  error: string | null = null;
  loaded = false;
  // Token da requisição mais recente (latest-wins). Evita que uma troca rápida de
  // escopo de tenant seja engolida por um fetch anterior ainda em voo.
  private reqSeq = 0;

  constructor() {
    makeAutoObservable(this);
  }

  setList(projects: Project[]) {
    this.list = projects;
  }

  setLoading(v: boolean) {
    this.loading = v;
  }

  setError(e: string | null) {
    this.error = e;
  }

  getById(id: string) {
    return this.list.find((p) => p.id === id) ?? null;
  }

  async loadProjects() {
    // Não usamos guarda por `loading` (engoliria a recarga disparada por troca de escopo).
    // Em vez disso: cada chamada recebe um token; só a resposta do token mais recente aplica.
    const seq = ++this.reqSeq;
    this.loading = true;
    this.error = null;
    try {
      // Master: escopa pelo tenant selecionado no topo (null = todos os tenants).
      const data = await apiGet<Project[]>(
        withQuery("/api/projects", { tenantId: tenantScopeStore.effectiveTenantId })
      );
      if (seq !== this.reqSeq) return; // resposta obsoleta — chegou um fetch mais novo
      this.list = Array.isArray(data) ? data : [];
      this.loaded = true;
    } catch (err) {
      if (seq !== this.reqSeq) return;
      this.error = err instanceof Error ? err.message : "Falha ao carregar projetos";
      this.list = [];
    } finally {
      if (seq === this.reqSeq) this.loading = false;
    }
  }

  async loadProject(id: string): Promise<Project | null> {
    try {
      const data = await apiGet<Project>(`/api/projects/${id}`);
      const existing = this.list.findIndex((p) => p.id === id);
      if (existing >= 0) this.list[existing] = data;
      else this.list.push(data);
      return data;
    } catch {
      return null;
    }
  }

  /** Atualiza o status do projeto na lista (ex.: após POST /run retornar 202 com status "running"). */
  setProjectStatus(id: string, status: Project["status"]) {
    const idx = this.list.findIndex((p) => p.id === id);
    if (idx >= 0) this.list[idx] = { ...this.list[idx], status };
  }
}

export const projectsStore = new ProjectsStore();
