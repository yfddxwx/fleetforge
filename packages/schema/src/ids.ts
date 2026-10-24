import { randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function newEventId(): string {
  return randomUUID();
}

/** Short branch-safe slug of arbitrary text (ASCII only: safe on all platforms). */
export function slugify(text: string, maxLen = 24): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return slug || "task";
}
