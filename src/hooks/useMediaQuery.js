// src/hooks/useMediaQuery.js
import { useEffect, useState } from "react";

// Subscribe to a CSS media query and re-render when it flips.
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

// Phone-sized viewport: narrow (below Tailwind's `md` breakpoint) OR short.
// The short-viewport clause keeps landscape phones - wide but only ~340-430px
// tall - on the mobile bottom-sheet layout instead of the cramped side panel.
// The 500px height mirrors the `sm`/`md` custom variants in src/index.css.
export const useIsMobile = () =>
  useMediaQuery("(max-width: 767px), (max-height: 499px)");
