import Link from "next/link";
import { ApiError } from "@/lib/api";

export type Failure = { status?: number; message: string };

export const fail = (e: unknown): Failure =>
  e instanceof ApiError ? { status: e.status, message: e.message } : { message: String(e) };

export default function ErrorBox({ error }: { error: Failure }) {
  return (
    <div role="alert" className="rounded-key border border-danger-border bg-danger-soft px-3.5 py-3 text-danger-text">
      {error.message}{" "}
      {error.status === 401 && <Link href="/settings" className="font-semibold underline underline-offset-2">Open Settings</Link>}
    </div>
  );
}
