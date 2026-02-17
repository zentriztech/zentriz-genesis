"use client";

import { makeAutoObservable } from "mobx";
import type { Project } from "@/types";

const mockProjects: Project[] = [
  {
    id: "p1",
    tenantId: "t1",
    createdBy: "u1",
    title: "API Voucher",
    specRef: "spec/PRODUCT_SPEC.md",
    status: "completed",
    charterSummary: "Charter gerado pelo CTO.",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "p2",
    tenantId: "t1",
    createdBy: "u1",
    title: "Portal Genesis",
    specRef: "spec/PORTAL_SPEC.md",
    status: "pm_backlog",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

class ProjectsStore {
  list: Project[] = mockProjects;
  loading = false;
  error: string | null = null;

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
}

export const projectsStore = new ProjectsStore();
