import { createHash } from "node:crypto";
import type { Marker } from "./markers.js";

function hashId(path: string, text: string, occurrence: number, salt: number): string {
  const hex = createHash("sha256").update([path, text, occurrence, salt].join("\0")).digest("hex");
  return parseInt(hex.slice(0, 8), 16).toString(36).padStart(4, "0").slice(-4);
}

/** An id for a new comment of `text` in `path` that is not in `taken`, which it then joins. */
export function freshId(path: string, text: string, taken: Set<string>): string {
  let salt = 0;
  let id = hashId(path, text, 0, salt);
  while (taken.has(id)) id = hashId(path, text, 0, ++salt);
  taken.add(id);
  return id;
}

/**
 * Final id per marker, in order. Pure in (path, markers) so that `clean` and `sync`
 * always agree: a new comment's id hashes path, text, and occurrence index, salted past
 * any id already present in the file. An expanded comment that reuses an earlier id with
 * different text (a copy-pasted line that was then edited) is re-identified as new.
 */
export function resolveIds(path: string, markers: readonly Marker[]): string[] {
  const taken = new Set<string>();
  for (const m of markers) if (m.id) taken.add(m.id);

  const textOf = new Map<string, string>();
  const occurrences = new Map<string, number>();
  return markers.map((m) => {
    if (m.id) {
      // One body reads multi-line on an own-line marker and flattened on a trailing one.
      const flat = m.text?.replaceAll("\n", " ");
      const earlier = textOf.get(m.id);
      if (flat === undefined || earlier === undefined || earlier === flat) {
        if (flat !== undefined) textOf.set(m.id, flat);
        return m.id;
      }
    }
    const text = m.text ?? "";
    const n = occurrences.get(text) ?? 0;
    occurrences.set(text, n + 1);
    let salt = 0;
    let id = hashId(path, text, n, salt);
    while (taken.has(id)) id = hashId(path, text, n, ++salt);
    taken.add(id);
    return id;
  });
}
