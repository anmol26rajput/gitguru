"use client";

import { useEffect, useState } from "react";
import { getSettings } from "@/lib/api";

const SHOW_AFTER_MS = 3000; // a warm server answers /health well inside this
const PING_TIMEOUT_MS = 5000; // a ping that hangs is retried, not waited on
const RETRY_MS = 2000;
const GIVE_UP_MS = 180_000; // a server that is down, not asleep, should not show this forever

// The free tier sleeps when idle. Ping /health on load (no token); if it has not answered after 3 s, say so.
// Any HTTP answer hides it. A network error or a 5 s timeout keeps it (a sleeping host often answers without CORS
// headers) and retries. Never blocks the page. If the server was slow or unreachable, the first answer fires
// "gitguru:awake" so pages that failed meanwhile (Home's repo list) can reload.
export default function Waking() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    const start = Date.now();
    let slow = false;
    const timer = setTimeout(() => {
      slow = true;
      setShow(true);
    }, SHOW_AFTER_MS);
    const url = getSettings().apiUrl.replace(/\/+$/, "") + "/health";
    (async () => {
      let awake = false;
      while (!ctl.signal.aborted && Date.now() - start < GIVE_UP_MS) {
        try {
          // AbortSignal.any is Chrome 116+, Safari 17.4+; older iPhones keep only the unmount abort
          const timeout = AbortSignal.any?.([ctl.signal, AbortSignal.timeout(PING_TIMEOUT_MS)]);
          await fetch(url, { signal: timeout ?? ctl.signal });
          awake = true;
          break;
        } catch {
          slow = true;
          await new Promise((r) => setTimeout(r, RETRY_MS));
        }
      }
      clearTimeout(timer);
      if (ctl.signal.aborted) return;
      setShow(false);
      if (awake && slow) window.dispatchEvent(new Event("gitguru:awake"));
    })();
    return () => {
      ctl.abort();
      clearTimeout(timer);
    };
  }, []);

  return (
    <div role="status">
      {show && (
        <p className="border-b border-border bg-bg-subtle px-6 py-2 text-center text-muted max-[900px]:px-4">
          Waking up the server… the free tier sleeps when idle, this can take a minute.
        </p>
      )}
    </div>
  );
}
