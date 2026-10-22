"use client";

import { useState, useSyncExternalStore } from "react";
import { api, getSettings, saveSettings } from "@/lib/api";

const input = "w-full rounded border border-gray-300 px-3 py-2 text-sm";

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
    <main className="mx-auto w-full max-w-md space-y-4 p-6">
      <h1 className="text-2xl font-bold">Settings</h1>
      <div>
        <label htmlFor="api-url" className="mb-1 block text-sm font-medium">API URL</label>
        <input id="api-url" className={input} value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} />
      </div>
      <div>
        <label htmlFor="token" className="mb-1 block text-sm font-medium">Token</label>
        <input id="token" type="password" className={input} value={token} onChange={(e) => setToken(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <button onClick={save} className="rounded bg-foreground px-4 py-2 text-sm text-background">Save</button>
        <button onClick={test} className="rounded border border-gray-300 px-4 py-2 text-sm">Test connection</button>
      </div>
      {msg && <p role="status" className="text-sm">{msg}</p>}
    </main>
  );
}
