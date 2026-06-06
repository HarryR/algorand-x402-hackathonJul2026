/**
 * Boundary validators for untrusted, client-controlled identifiers.
 *
 * The orchestrator accepts a client-chosen idempotency `id`, package upload
 * names, and a `require` module string — all of which flow into filesystem
 * paths (instance dir, boot log, in-zip pkg entry) and into the guest loader.
 * `id` is documented as "opaque, any string" (src/shared/idempotency.ts), but
 * opaque-to-the-server must NOT mean unvalidated-at-the-FS-boundary: an
 * unconstrained id reaches a recursive delete (src/orchestrator/instance.ts).
 *
 * Policy is reject-don't-sanitize — a value either matches a strict shape or is
 * refused with a clear message. We never strip/normalize and proceed, because a
 * silently-rewritten id breaks idempotency and a silently-rewritten name can
 * still collide. Dependency-free so the CLI and server share one source of truth.
 *
 * Validated shapes (see SECURITY notes in src/orchestrator/server.ts):
 *   - id:       ^[A-Za-z0-9_-]{1,64}$       (hex hashes and nametags both fit)
 *   - pkg name: <stem>.zip, stem ^[A-Za-z0-9_-]{1,64}$
 *   - require:  dotted Lua identifiers, <=128 chars
 */

/** Idempotency id: alnum, dash, underscore; 1-64 chars. No slashes, dots, or %-encoding. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Package-name stem (before the required `.zip`): alnum, dash, underscore; 1-64 chars. */
const PKG_STEM_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** One Lua identifier segment: leading letter/underscore, then alnum/underscore. */
const REQUIRE_SEGMENT = '[A-Za-z_][A-Za-z0-9_]*';
/** Dotted Lua module path, e.g. `hello`, `nt.net.afd`. */
const REQUIRE_RE = new RegExp(`^${REQUIRE_SEGMENT}(\\.${REQUIRE_SEGMENT})*$`);
const REQUIRE_MAX = 128;

/** Thrown on a validation failure; carries a 400-appropriate message. */
export class ValidationError extends Error {}

/**
 * Validate a client-chosen idempotency id. Returns it unchanged on success;
 * throws ValidationError otherwise. Reject (don't sanitize) so the id that
 * reaches the filesystem is byte-identical to the one the client keyed on.
 *
 * NOTE on URL-encoding: the caller decodes the path segment ONCE before calling
 * this. `%2F`->`/` and `%2E`->`.` are outside the charset, so any percent-escape
 * that smuggles a separator is rejected here. Do not decode twice.
 */
export function assertValidId(id: string): string {
  if (!ID_RE.test(id)) {
    throw new ValidationError(
      `invalid id: must match [A-Za-z0-9_-] and be 1-64 chars (got ${describe(id)})`,
    );
  }
  return id;
}

/**
 * Validate a package upload filename. Must be `<stem>.zip` where the stem is
 * 1-64 chars of [A-Za-z0-9_-] — no slashes, no `..`, no nested extensions. The
 * name becomes the in-zip entry `pkg/<name>` (user code in the Lua namespace),
 * so it must not contain a path separator or collide via traversal.
 */
export function assertValidPackageName(name: string): string {
  if (!name.toLowerCase().endsWith('.zip')) {
    throw new ValidationError(`invalid package name: must end in ".zip" (got ${describe(name)})`);
  }
  const stem = name.slice(0, -'.zip'.length);
  if (!PKG_STEM_RE.test(stem)) {
    throw new ValidationError(
      `invalid package name: "<stem>.zip" with stem [A-Za-z0-9_-], 1-64 chars (got ${describe(name)})`,
    );
  }
  return name;
}

/**
 * Validate the `require` module string: dotted Lua identifiers, <=128 chars.
 * Rejects leading digits, empty segments (`a..b`), dashes, slashes, and
 * absolute paths — keeping it to a shape the guest loader resolves to a FAT16
 * path safely.
 */
export function assertValidRequire(mod: string): string {
  if (mod.length > REQUIRE_MAX || !REQUIRE_RE.test(mod)) {
    throw new ValidationError(
      `invalid require: must be dotted Lua identifiers (e.g. "nt.net.afd"), <=${REQUIRE_MAX} chars (got ${describe(mod)})`,
    );
  }
  return mod;
}

/** Render an untrusted value for an error message: truncated, control chars stripped, quoted. */
function describe(s: string): string {
  const clipped = s.length > 80 ? `${s.slice(0, 80)}...` : s;
  // Replace control chars (0x00-0x1f, 0x7f) with '?' so the message can't
  // smuggle terminal escapes; JSON.stringify then quotes and escapes the rest.
  let safe = '';
  for (const ch of clipped) {
    const code = ch.codePointAt(0)!;
    safe += code < 0x20 || code === 0x7f ? '?' : ch;
  }
  return JSON.stringify(safe);
}
