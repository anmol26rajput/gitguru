"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { useEmbed } from "@/components/Embed";
import { Key, Sheet } from "@/components/ui";
import { api, getSettings, saveSettings } from "@/lib/api";

const input = "w-full rounded-key border border-border bg-bg-subtle px-3 py-2 font-mono text-[13px]";

// localStorage only exists in the browser: render the form after hydration so
// its initial state can read the saved settings without a hydration mismatch.
const noop = () => () => {};
export default function SettingsPage() {
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  return mounted ? <SettingsForm /> : null;
}

function SettingsForm() {
  const embed = useEmbed();
  const [{ apiUrl: initUrl, token: initToken }] = useState(getSettings);
  const [apiUrl, setApiUrl] = useState(initUrl);
  const [token, setToken] = useState(initToken);
  const [msg, setMsg] = useState("");

  function save() {
    saveSettings({ apiUrl, token });
    setMsg("Saved");
  }

  async function test() {
    saveSettings({ apiUrl, token });
    setMsg("Testing...");
    try {
      const { owner } = await (await api("/health")).json(); // open to everyone; says whether the token is the owner's
      if (!token.trim()) setMsg("Connected");
      else setMsg(owner ? "Connected as the owner." : "Connected. This token is not the owner token, so you are a guest.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main className="mx-auto w-full max-w-md px-6 pt-10 pb-20">
      {/* Embedded: no top Nav, so give the way back. */}
      {embed && <Link href="/?embed=1" className="mb-4 inline-flex min-h-11 items-center rounded-md text-muted">← Back</Link>}
      <Sheet className="space-y-5 p-6">
        <div>
          <h1 className="text-[28px] leading-tight font-[750] tracking-[-0.025em]">Settings</h1>
          <p className="mt-1 text-muted">Where this app finds your GitGuru API.</p>
        </div>
        <div>
          <label htmlFor="api-url" className="mb-1.5 block font-semibold">API URL</label>
          <input id="api-url" className={input} value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} />
        </div>
        <div>
          <label htmlFor="token" className="mb-1.5 block font-semibold">Owner token (optional)</label>
          <input id="token" type="password" aria-describedby="token-hint" className={input} value={token} onChange={(e) => setToken(e.target.value)} />
          <p id="token-hint" className="mt-1.5 text-[13px] text-muted">Only needed to delete repos and to skip the daily limits.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Key onClick={save}>Save</Key>
          <Key variant="ghost" onClick={test}>Test connection</Key>
          {msg && <p role="status" className="text-muted">{msg}</p>}
        </div>
      </Sheet>
    </main>
  );
}
