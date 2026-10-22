import Link from "next/link";
import { ApiError } from "@/lib/api";

export type Failure = { status?: number; message: string };

export const fail = (e: unknown): Failure =>
  e instanceof ApiError ? { status: e.status, message: e.message } : { message: String(e) };

export default function ErrorBox({ error }: { error: Failure }) {
  return (
    <div role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
      {error.message}{" "}
      {error.status === 401 && <Link href="/settings" className="font-medium underline">Open Settings</Link>}
    </div>
  );
}
