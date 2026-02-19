"use client";

import { makeAutoObservable } from "mobx";
import type { Project } from "@/types";
import { apiGet } from "@/lib/api";

class ProjectsStore {
  list: Project[] = [];
  loading = false;
  error: string | null = null;
  loaded = false;

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
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    try {
      const data = await apiGet<Project[]>("/api/projects");
      this.list = Array.isArray(data) ? data : [];
      this.loaded = true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Falha ao carregar projetos";
      this.list = [];
    } finally {
      this.loading = false;
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
