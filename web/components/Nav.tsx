"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEmbed } from "@/components/Embed";

// Slim header: logo home, Settings on the right (44px tall tap targets on phones). Repo pages have their own header (RepoTabs) instead.
export default function Nav() {
  const embed = useEmbed();
  const onRepo = usePathname().startsWith("/r/");
  if (embed || onRepo) return null; // the side panel has its own tiny header (Home, repo pages)
  return (
    <header className="flex items-center px-6 py-4 max-[900px]:py-1.5">
      <nav aria-label="Main" className="flex flex-1 items-center">
        <Link href="/" className="rounded-md font-mono font-bold text-accent-text max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center">
          <span aria-hidden="true">◆ </span>gitguru
        </Link>
        <Link href="/settings" className="ml-auto rounded-md text-muted max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center max-[900px]:-mr-2 max-[900px]:px-2">
          Settings
        </Link>
      </nav>
    </header>
  );
}
