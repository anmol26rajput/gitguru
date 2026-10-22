"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Chat", path: "" },
  { label: "Diagram", path: "/diagram" },
  { label: "Walkthrough", path: "/walk" },
  { label: "Eval", path: "/eval" },
];

export default function RepoTabs({ repoId }: { repoId: number }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Repo sections" className="flex gap-1 border-b border-foreground/20 px-6 pt-2">
      {TABS.map(({ label, path }) => {
        const href = `/r/${repoId}${path}`;
        const active = pathname === href;
        return (
          <Link
            key={label}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${active ? "border-foreground font-medium" : "border-transparent text-foreground/70 hover:text-foreground"}`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
