"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type Repo } from "@/lib/api";
import { KeyLink, PillLink } from "./ui";

const TABS = [
  { label: "Chat", path: "" },
  { label: "Diagram", path: "/diagram" },
  { label: "Walkthrough", path: "/walk" },
  { label: "Quality", path: "/eval" },
];

// Repo header: logo home, the repo name, the section pills and Settings. Wraps when narrow; from 900px it is one
// sticky line of fixed height (--repo-header-h), so the code panel can sit exactly below it.
export default function RepoTabs({ repoId }: { repoId: number }) {
  const pathname = usePathname();
  const [title, setTitle] = useState("");

  useEffect(() => {
    // The name is decoration: on failure each tab shows its own error, so stay quiet here.
    api(`/repos/${repoId}`)
      .then((r) => r.json())
      .then((r: Repo) => setTitle(r.title))
      .catch(() => {});
  }, [repoId]);

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-bg px-6 py-3.5 min-[900px]:sticky min-[900px]:top-0 min-[900px]:z-[5] min-[900px]:h-[var(--repo-header-h)] min-[900px]:flex-nowrap min-[900px]:py-0">
      <Link href="/" className="shrink-0 rounded-md font-mono font-bold text-accent-text">
        <span aria-hidden="true">◆ </span>gitguru
      </Link>
      {title && (
        <span className="min-w-0 truncate font-mono text-muted">
          <span aria-hidden="true">/ </span>
          {title}
        </span>
      )}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2 min-[900px]:shrink-0">
        <nav aria-label="Repo sections" className="flex flex-wrap gap-0.5">
          {TABS.map(({ label, path }) => {
            const href = `/r/${repoId}${path}`;
            return (
              <PillLink key={label} href={href} active={pathname === href}>
                {label}
              </PillLink>
            );
          })}
        </nav>
        <KeyLink href="/settings" variant="ghost" size="sm">
          Settings
        </KeyLink>
      </div>
    </header>
  );
}
