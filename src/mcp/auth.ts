import * as crypto from "crypto";

/**
 * Generate a fresh auth token. 32 random bytes → 64 hex chars.
 * Roughly 256 bits of entropy — sufficient for an unguessable bearer
 * token over a localhost-bound connection.
 */
export function generateToken(): string {
	return crypto.randomBytes(32).toString("hex");
}

/**
 * Pull the token out of an HTTP `Authorization` header. Accepts either:
 *   - `Bearer <token>` (the standard form, used by mcp-remote)
 *   - the raw token (Claude Code IDE protocol passes it without the prefix
 *     in `x-claude-code-ide-authorization`).
 *
 * Returns null if no token is present.
 */
export function extractBearerToken(
	headerValue: string | string[] | undefined
): string | null {
	if (!headerValue) return null;
	const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
	if (typeof value !== "string") return null;

	const trimmed = value.trim();
	if (!trimmed) return null;

	// Anything that looks like Bearer-scheme syntax must parse as such.
	// `Bearer` alone or `Bearer ` (no token) is malformed → reject.
	if (/^Bearer\b/i.test(trimmed)) {
		const m = trimmed.match(/^Bearer\s+(.+)$/i);
		if (!m) return null;
		const token = m[1].trim();
		return token || null;
	}

	return trimmed;
}

/**
 * Constant-time string comparison. Avoids leaking token length or content
 * through timing differences. Both inputs must be the same length to match —
 * a length mismatch returns false without ever calling timingSafeEqual.
 */
export function safeCompare(a: string, b: string): boolean {
	if (typeof a !== "string" || typeof b !== "string") return false;
	if (a.length !== b.length) return false;
	if (a.length === 0) return false;

	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Validate a presented token against the expected one. Returns true only
 * if both are non-empty strings of the same length and bytes match.
 */
export function isAuthorized(
	expected: string,
	presented: string | null | undefined
): boolean {
	if (!expected || !presented) return false;
	return safeCompare(expected, presented);
}
