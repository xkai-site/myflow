import { stripVTControlCharacters } from "node:util";

/** Redact before truncating so a shortened secret cannot escape the filter. */
export function sanitizeError(value: string, secrets: readonly string[] = [], maxLength = 800): string {
	let sanitized = value;
	for (const secret of secrets) {
		if (!secret) continue;
		const variants = secret.length <= 8192
			? [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)] : [secret];
		for (const variant of variants) sanitized = sanitized.split(variant).join("[redacted]");
	}
	sanitized = stripVTControlCharacters(sanitized)
		.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
		.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "data:image/[redacted]")
		.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
		.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[token-redacted]")
		.replace(/[A-Za-z0-9+/]{256,}={0,2}/g, "[large-payload-redacted]")
		.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, " ")
		.trim();
	return sanitized.length <= maxLength ? sanitized : `${sanitized.slice(0, maxLength)}…`;
}

export function sanitizeDiagnosticText(value: string, secrets: readonly string[] = [], maxLength = 240): string {
	// Error messages may contain signed CDN URLs or authenticated proxy URLs.
	return sanitizeError(sanitizeError(value, secrets, Number.MAX_SAFE_INTEGER)
		.replace(/https?:\/\/[^\s<>"']+/gi, "[url-redacted]")
		.replace(/\b(?:authorization|cookie|set-cookie|api[-_]?key|token|password|signature)\s*[:=]\s*[^\s,;]+/gi, "[credential-redacted]")
		.replace(/\s+/g, " "), [], maxLength);
}
