/**
 * Idempotency id derivation.
 *
 * The id is OPAQUE to the server (it never recomputes or validates it). The
 * client may pass any string — a nametag, or this deterministic hash of the
 * inputs. When omitted, the CLI derives it here so that the same packages +
 * module + args always map to the same id (and thus the same cached output).
 *
 * Dependency-free so the CLI binary and a future MCP endpoint can both use it.
 */

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive a deterministic idempotency id from the package zip bytes, the module
 * to require, and the args. Package order does not matter (hashes are sorted);
 * arg order does (it changes the call).
 */
export async function deriveId(
  packageBytes: Uint8Array[],
  requireModule: string,
  args: string[],
): Promise<string> {
  const pkgHashes = (await Promise.all(packageBytes.map((b) => sha256Hex(b)))).sort();
  return sha256Hex(JSON.stringify({ pkgHashes, require: requireModule, args }));
}
