"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Slim header: logo home, Settings on the right. Repo pages have their own header (RepoTabs) instead.
export default function Nav() {
  if (usePathname().startsWith("/r/")) return null;
  return (
    <header className="flex items-center px-6 py-4">
      <nav aria-label="Main" className="flex flex-1 items-center">
        <Link href="/" className="rounded-md font-mono font-bold text-accent-text">
          <span aria-hidden="true">◆ </span>gitguru
        </Link>
        <Link href="/settings" className="ml-auto rounded-md text-muted">
          Settings
        </Link>
      </nav>
    </header>
  );
}
