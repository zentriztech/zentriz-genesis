import { makeAutoObservable } from "mobx";

type ThemeMode = "dark" | "light";

class ThemeStore {
  mode: ThemeMode = "dark";

  constructor() {
    makeAutoObservable(this);
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("genesis_theme") as ThemeMode | null;
      if (saved === "light" || saved === "dark") this.mode = saved;
    }
  }

  toggle() {
    this.mode = this.mode === "dark" ? "light" : "dark";
    if (typeof window !== "undefined") localStorage.setItem("genesis_theme", this.mode);
  }

  get isDark() {
    return this.mode === "dark";
  }
}

export const themeStore = new ThemeStore();
