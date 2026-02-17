"use client";

import { makeAutoObservable } from "mobx";
import type { User, Tenant } from "@/types";

export const PLANS = [
  { id: "prata", slug: "prata" as const, name: "Prata", maxProjects: 3, maxUsersPerTenant: 5 },
  { id: "ouro", slug: "ouro" as const, name: "Ouro", maxProjects: 10, maxUsersPerTenant: 20 },
  { id: "diamante", slug: "diamante" as const, name: "Diamante", maxProjects: 50, maxUsersPerTenant: 100 },
];

class AuthStore {
  user: User | null = null;
  tenant: Tenant | null = null;
  token: string | null =
    typeof window !== "undefined" ? localStorage.getItem("genesis_token") : null;

  constructor() {
    makeAutoObservable(this);
  }

  get isZentrizAdmin() {
    return this.user?.role === "zentriz_admin";
  }

  get isTenantAdmin() {
    return this.user?.role === "tenant_admin" || this.isZentrizAdmin;
  }

  get isAuthenticated() {
    return !!this.token && !!this.user;
  }

  login(email: string, password: string, role: "user" | "tenant_admin" | "zentriz_admin" = "user") {
    this.token = "mock-jwt-" + Math.random().toString(36).slice(2);
    const user = {
      id: "u1",
      email,
      name: email.split("@")[0],
      tenantId: role === "zentriz_admin" ? null : "t1",
      role,
      status: "active" as const,
      createdAt: new Date().toISOString(),
    };
    this.user = user;
    if (user.tenantId) {
      this.tenant = {
        id: "t1",
        name: "Tenant Demo",
        planId: "ouro",
        plan: PLANS[1],
        status: "active",
        createdAt: new Date().toISOString(),
      };
    } else {
      this.tenant = null;
    }
    if (typeof window !== "undefined") {
      localStorage.setItem("genesis_token", this.token);
      localStorage.setItem("genesis_user", JSON.stringify({ email: user.email, role: user.role, tenantId: user.tenantId }));
    }
  }

  hydrate() {
    if (typeof window === "undefined") return;
    const t = localStorage.getItem("genesis_token");
    const u = localStorage.getItem("genesis_user");
    if (t && u) {
      try {
        const { email, role, tenantId } = JSON.parse(u);
        this.token = t;
        this.user = {
          id: "u1",
          email,
          name: email.split("@")[0],
          tenantId: tenantId ?? null,
          role: role ?? "user",
          status: "active",
          createdAt: new Date().toISOString(),
        };
        if (this.user.tenantId) {
          this.tenant = { id: "t1", name: "Tenant Demo", planId: "ouro", plan: PLANS[1], status: "active", createdAt: new Date().toISOString() };
        } else {
          this.tenant = null;
        }
      } catch {
        this.token = null;
        this.user = null;
        this.tenant = null;
      }
    }
  }

  logout() {
    this.user = null;
    this.tenant = null;
    this.token = null;
    if (typeof window !== "undefined") localStorage.removeItem("genesis_token");
  }

  setUser(user: User | null) {
    this.user = user;
  }

  setTenant(tenant: Tenant | null) {
    this.tenant = tenant;
  }
}

export const authStore = new AuthStore();
