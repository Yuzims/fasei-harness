/**
 * Deterministic bounds for GitHub PR unified diffs.
 * Never send an unbounded PR patch to FileChangeSnapshot or the LLM.
 */

export const MAX_PATCH_CHARS_PER_FILE = 8_192;
export const MAX_TOTAL_PATCH_CHARS = 32_768;

export interface BoundedPatch {
  patch?: string;
  patchTruncated?: boolean;
}

export function boundPatch(patch: unknown, maxChars = MAX_PATCH_CHARS_PER_FILE): BoundedPatch {
  if (typeof patch !== "string" || patch.length === 0) {
    return {};
  }
  const limit = Math.max(0, Math.min(maxChars, MAX_PATCH_CHARS_PER_FILE));
  if (limit <= 0) {
    return { patchTruncated: true };
  }
  if (patch.length <= limit) {
    return { patch, patchTruncated: false };
  }
  return { patch: patch.slice(0, limit), patchTruncated: true };
}

export function applyPatchBudget<T extends BoundedPatch>(files: readonly T[]): T[] {
  let remaining = MAX_TOTAL_PATCH_CHARS;
  return files.map((file) => {
    const bounded = boundPatch(file.patch, remaining);
    if (bounded.patch === undefined && bounded.patchTruncated === undefined) {
      return file;
    }
    remaining -= bounded.patch?.length ?? 0;
    const alreadyTruncated = file.patchTruncated === true;
    if (bounded.patch === undefined) {
      const next = { ...file };
      delete next.patch;
      next.patchTruncated = true;
      return next;
    }
    return {
      ...file,
      patch: bounded.patch,
      patchTruncated: alreadyTruncated || bounded.patchTruncated === true,
    };
  });
}
