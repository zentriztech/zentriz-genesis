"use client";

import { makeAutoObservable, runInAction } from "mobx";
import type { User } from "@/types";
import { apiGet, apiPatch, apiDelete } from "@/lib/api";

export type UpdateUserPayload = {
  name?: string;
  email?: string;
  password?: string;
  role?: string;
};

class UsersStore {
  users: User[] = [];
  loading = false;
  error: string | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  async loadUsers() {
    this.loading = true;
    this.error = null;
    try {
      const data = await apiGet<User[]>("/api/users");
      runInAction(() => {
        this.users = data;
      });
    } catch (err) {
      runInAction(() => {
        this.error = err instanceof Error ? err.message : "Erro ao carregar usuários";
      });
    } finally {
      runInAction(() => {
        this.loading = false;
      });
    }
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
