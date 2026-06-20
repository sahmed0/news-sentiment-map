// src/hooks/useTheme.js
import { useEffect, useState } from "react";

const STORAGE_KEY = "nsm-theme";

// Light by default; remembers the user's choice across sessions.
export function useTheme() {
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "light";
    return localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, theme);
    // Mirror the theme onto <html> so the theme's `--bg-rgb` cascades to
    // html/body (their background fills the iOS safe-area below the bottom bar).
    document.documentElement.classList.toggle("theme-light", theme === "light");
  }, [theme]);

  const toggle = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  return { theme, toggle };
}
