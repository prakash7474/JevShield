/**
 * Tauri v2 injects `__TAURI_INTERNALS__` into the webview. Detecting it lets us
 * enable desktop-only behaviour without importing `@tauri-apps/api` in the
 * browser build (where those calls would throw).
 */
export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

export async function getShellVersion(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return null;
  }
}
