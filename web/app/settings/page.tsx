"use client";

import { useState, useSyncExternalStore } from "react";
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
      await api("/repos");
      setMsg("Connected");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main className="mx-auto w-full max-w-md px-6 pt-10 pb-20">
      <Sheet className="space-y-5 p-6">
        <div>
          <h1 className="text-[28px] leading-tight font-[750] tracking-[-0.025em]">Settings</h1>
          <p className="mt-1 text-muted">Where this app finds your GitGuru API, and the token it sends.</p>
        </div>
        <div>
          <label htmlFor="api-url" className="mb-1.5 block font-semibold">API URL</label>
          <input id="api-url" className={input} value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} />
        </div>
        <div>
          <label htmlFor="token" className="mb-1.5 block font-semibold">Token</label>
          <input id="token" type="password" className={input} value={token} onChange={(e) => setToken(e.target.value)} />
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
