import { useEffect, useState } from "react";

/**
 * Top-level views. Deliberately a union rather than a router dependency: the
 * Studio is a single-window desktop app, so the URL hash is all the persistence
 * a "route" needs — and it keeps deep links such as `#/chat` working.
 */
export type StudioRoute = "workbench" | "chat";

export const ROUTES: ReadonlyArray<{
  id: StudioRoute;
  label: string;
  title: string;
}> = [
  {
    id: "workbench",
    label: "Workbench",
    title: "Design, audit and replay Jev decision pipelines",
  },
  { id: "chat", label: "Chat", title: "Talk to Jev one message at a time" },
];

const HASH_BY_ROUTE: Record<StudioRoute, string> = {
  workbench: "#/workbench",
  chat: "#/chat",
};

/** Anything that is not a known route (including an empty hash) is the workbench. */
export function parseRoute(hash: string): StudioRoute {
  const normalized = hash.trim().toLowerCase();
  return normalized === HASH_BY_ROUTE.chat ? "chat" : "workbench";
}

export function navigate(route: StudioRoute): void {
  const hash = HASH_BY_ROUTE[route];
  if (window.location.hash !== hash) window.location.hash = hash;
}

/** Subscribes to `hashchange` so the rendered view always matches the URL. */
export function useRoute(): StudioRoute {
  const [route, setRoute] = useState<StudioRoute>(() =>
    parseRoute(window.location.hash),
  );

  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return route;
}
