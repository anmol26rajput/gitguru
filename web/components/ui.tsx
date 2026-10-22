// Shared look (docs/DESIGN-UI.md). Each piece is a plain element plus a CSS class
// from globals.css; `className` is appended so Tailwind utilities can adjust it.
import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, HTMLAttributes } from "react";

type KeyStyle = { variant?: "primary" | "ghost"; size?: "md" | "sm" };

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");
const keyClass = ({ variant = "primary", size = "md" }: KeyStyle, className?: string) =>
  cx(variant === "ghost" ? "key-ghost" : "key", size === "sm" && "key-sm", className);

/** Raised button. Defaults to type="button" so it never submits a form by accident. */
export function Key({ variant, size, className, type = "button", ...props }: KeyStyle & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={keyClass({ variant, size }, className)} {...props} />;
}

/** A Key that navigates (Next Link). */
export function KeyLink({ variant, size, className, ...props }: KeyStyle & ComponentProps<typeof Link>) {
  return <Link className={keyClass({ variant, size }, className)} {...props} />;
}

/** Card with a second sheet peeking out underneath. For a card that links, put className="sheet" on the Link. */
export function Sheet({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("sheet", className)} {...props} />;
}

/** Tab pill. Active when the current page: sets aria-current="page". */
export function PillLink({ active, className, ...props }: { active?: boolean } & ComponentProps<typeof Link>) {
  return <Link aria-current={active ? "page" : undefined} className={cx("pill", className)} {...props} />;
}

/** Action pill (e.g. Read aloud). Pass aria-pressed to show it filled while on. */
export function Pill({ className, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={cx("pill", className)} {...props} />;
}

/** Mono chip button (citation number, source path). Its text is its accessible name unless aria-label is given. */
export function Chip({ className, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={cx("chip", className)} {...props} />;
}
