"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { embedHref, useEmbed } from "@/components/Embed";
import { api, type Repo } from "@/lib/api";
import { KeyLink, PillLink } from "./ui";

const TABS = [
  { label: "Chat", path: "" },
  { label: "Diagram", path: "/diagram" },
  { label: "Walkthrough", path: "/walk" },
  { label: "Quality", path: "/eval" },
];

// Repo header: logo home, the repo name, the section pills and Settings. From 900px it is one sticky line of fixed
// height (--repo-header-h), so the code panel can sit exactly below it. Below 900px: logo, name (truncated) and
// Settings on the first line; the pills on a second line that scrolls sideways inside its own strip, never the page.
export default function RepoTabs({ repoId }: { repoId: number }) {
  const pathname = usePathname();
  const embed = useEmbed();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("");

  useEffect(() => {
    // The name is decoration: on failure each tab shows its own error, so stay quiet here.
    api(`/repos/${repoId}`)
      .then((r) => r.json())
      .then((r: Repo) => {
        setTitle(r.title);
        setKind(r.kind);
      })
      .catch(() => {});
  }, [repoId]);

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-bg px-6 py-3.5 max-[900px]:py-2 min-[900px]:sticky min-[900px]:top-0 min-[900px]:z-[5] min-[900px]:h-[var(--repo-header-h)] min-[900px]:flex-nowrap min-[900px]:py-0">
      <Link href={embedHref("/", embed)} className="shrink-0 rounded-md font-mono font-bold text-accent-text max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center">
        <span aria-hidden="true">◆ </span>gitguru
      </Link>
      {title && (
        <span className="min-w-0 truncate font-mono text-muted max-[900px]:flex-1">
          <span aria-hidden="true">/ </span>
          {title}
        </span>
      )}
      {/* Phones: last, full width, one row; the 4px padding (offset by the negative margin) keeps focus rings unclipped. */}
      <nav
        aria-label="Repo sections"
        className="flex gap-0.5 max-[900px]:order-last max-[900px]:-m-1 max-[900px]:w-[calc(100%+0.5rem)] max-[900px]:shrink-0 max-[900px]:overflow-x-auto max-[900px]:p-1 max-[900px]:[scrollbar-width:none] min-[900px]:ml-auto min-[900px]:shrink-0"
      >
        {/* A web page has no code to walk through or grade (its Walkthrough is a 422): Walkthrough and Quality show only
            once the repo is known to be code (kind is "" until loaded, and stays "" if the fetch fails). */}
        {TABS.filter((t) => (kind !== "" && kind !== "page") || t.path === "" || t.path === "/diagram").map(({ label, path }) => {
          const href = `/r/${repoId}${path}`;
          return (
            <PillLink key={label} href={embedHref(href, embed)} active={pathname === href} className="shrink-0">
              {label}
            </PillLink>
          );
        })}
      </nav>
      <KeyLink href={embedHref("/settings", embed)} variant="ghost" size="sm" className="shrink-0 max-[900px]:ml-auto">
        Settings
      </KeyLink>
    </header>
  );
}
