// src/hooks/useTheme.ts
import { useEffect, useState } from "react";

type Theme = "light" | "dark";

// Only an explicit toggle is saved, so a visitor who never chose follows the
// default. The old "nsm-theme" key saved the theme on every visit - including
// the old light default - so it's dropped rather than read.
const STORAGE_KEY = "nsm-theme-choice";

// Dark by default; remembers the user's choice across sessions.
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });

  useEffect(() => {
    // Mirror the theme onto <html> so the theme's `--bg-rgb` cascades to
    // html/body (their background fills the iOS safe-area below the bottom bar).
    document.documentElement.classList.toggle("theme-light", theme === "light");
  }, [theme]);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private browsing / storage disabled - the choice lasts this visit only.
    }
  };
  return { theme, toggle };
}
