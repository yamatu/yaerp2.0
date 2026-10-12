"use client";

import { useEffect, useState } from "react";

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/** Phone layout: matches the breakpoint where the mobile tab bar is shown. */
export function useIsMobileLayout() {
  return useMediaQuery("(max-width: 767px)");
}

export function useCoarsePointer() {
  return useMediaQuery("(pointer: coarse)");
}
