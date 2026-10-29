import { isRunSessionId, RUN_SESSION_HEADER } from "@/lib/run-session";

export const CLIENT_SESSION_STORAGE_KEY = "q-split:session-id";
type SessionBrowser = { readonly sessionStorage: Pick<Storage, "getItem" | "setItem"> };

/** Prefer Web Crypto, with a UUID-shaped fallback for older browsers and tests. */
export function createClientId(): string {
  try { return globalThis.crypto.randomUUID(); } catch { /* Try random bytes next. */ }
  const bytes = new Uint8Array(16);
  try { globalThis.crypto.getRandomValues(bytes); } catch {
    for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Lazily initialize one tab's token before its first request, outside rendering.
 * sessionStorage survives reloads; memory keeps all requests in one workspace if
 * storage is blocked. Once selected, the token stays fixed for queued saves too.
 * Independent clients allow browser lifetimes to be exercised without a DOM.
 */
export function createSessionClient(getBrowser: () => SessionBrowser | null = () => typeof window === "undefined" ? null : window) {
  let sessionId: string | null = null;

  function getSessionId(): string | null {
    const browser = getBrowser();
    if (!browser) return null; // Never manufacture a shared server-side session.
    if (sessionId) return sessionId;
    let storage: SessionBrowser["sessionStorage"] | undefined;
    try {
      storage = browser.sessionStorage;
      const stored = storage.getItem(CLIENT_SESSION_STORAGE_KEY);
      if (isRunSessionId(stored)) sessionId = stored;
    } catch { /* Privacy settings may reject storage access or reads. */ }
    if (!sessionId) sessionId = createClientId();
    try { storage?.setItem(CLIENT_SESSION_STORAGE_KEY, sessionId); } catch { /* Use memory for this page lifetime. */ }
    return sessionId;
  }

  async function fetchWithSession(path: string, options: RequestInit = {}): Promise<Response> {
    const token = getSessionId();
    // Accidental SSR calls must not query the unassigned legacy workspace.
    if (!token) throw new Error("Session requests require a browser session.");
    const headers = new Headers(options.headers);
    headers.set(RUN_SESSION_HEADER, token);
    return fetch(path, { ...options, headers });
  }

  return { getSessionId, fetch: fetchWithSession };
}

// Construction performs no browser/storage access during SSR or module import.
export const { getSessionId: getClientSessionId, fetch: sessionFetch } = createSessionClient();
