import Link from "next/link";

export default function Nav() {
  return (
    <nav className="flex items-center gap-4 border-b border-gray-200 px-6 py-3 text-sm">
      <span className="font-semibold">GitGuru</span>
      <Link href="/" className="hover:underline">Repos</Link>
      <Link href="/settings" className="hover:underline">Settings</Link>
    </nav>
  );
}
