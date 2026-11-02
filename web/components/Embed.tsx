"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { acceptPageMessage, acceptPing, offerPage } from "@/lib/embed";

// Embed mode (the extension's side-panel iframe) is the `embed=1` query parameter. It persists because every
// in-app link goes through embedHref(), so the flag is on the URL of every page the panel visits.
let readySent = false; // once per page load, even if React mounts the bridge twice (StrictMode)
const EmbedContext = createContext(false);
export const useEmbed = () => useContext(EmbedContext);
export const embedHref = (href: string, embed: boolean) => (embed ? `${href}${href.includes("?") ? "&" : "?"}embed=1` : href);

// Needs <Suspense> around it (useSearchParams).
export function EmbedProvider({ children }: { children: ReactNode }) {
  const embed = useSearchParams().get("embed") === "1";
  return (
    <EmbedContext.Provider value={embed}>
      {embed && <PageBridge />}
      {children}
    </EmbedContext.Provider>
  );
}

// Page text from the extension (accepted only from chrome-extension:// parents). Whatever screen the panel is on,
// hand it to Home, which indexes it and opens Chat. Tells the parent when it is listening (once per load, and on
// every gitguru:ping).
function PageBridge() {
  const router = useRouter();
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (acceptPing(event, window.parent)) {
        // Every ping gets an answer, so the panel never depends on whether its iframe load or our ready came first.
        window.parent.postMessage({ type: "gitguru:ready" }, event.origin);
        return;
      }
      const page = acceptPageMessage(event, window.parent);
      if (!page) return;
      offerPage(page);
      if (window.location.pathname !== "/") router.push("/?embed=1");
    };
    window.addEventListener("message", onMessage);
    if (!readySent && window.parent !== window) {
      readySent = true;
      window.parent.postMessage({ type: "gitguru:ready" }, "*"); // no data, so "*" is safe
    }
    return () => window.removeEventListener("message", onMessage);
  }, [router]);
  return null;
}
