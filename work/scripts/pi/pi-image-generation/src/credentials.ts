import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { ImageAdapter, ImageProviderConfig } from "./model-config.ts";

export const QWEN_BASE_URL = "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1";
const MAX_STORE_BYTES = 64 * 1024;
export const MAX_KEY_CHARS = 4096;
export interface AuthRegistry {
	getProvider(id: string): { baseUrl?: string } | undefined;
	getProviderAuthStatus(id: string): { configured: boolean };
	getProviderAuth(id: string): Promise<{ auth: { apiKey?: string; baseUrl?: string; headers?: Record<string, string | null> } } | undefined>;
}
export interface ImageAccountStatus { configured: boolean; source: string; error?: string }
export interface ResolvedImageAuth { apiKey: string; baseUrl: string; headers?: Record<string, string | null> }
interface Store { version: 1; keys: Record<string, string> }

export function getCredentialPath(agentDir: string): string { return path.join(agentDir, "pi-image-generation", "auth.json"); }
export function validateKey(value: string): string {
	const key = value.trim();
	if (!key || key.length > MAX_KEY_CHARS || /[^\x21-\x7e]/u.test(key)) throw new Error("API Key must be non-empty printable ASCII without spaces (max 4096 characters)");
	return key;
}

export async function getAccountStatus(provider: ImageProviderConfig, agentDir: string, registry: AuthRegistry, env: NodeJS.ProcessEnv = process.env, ignoreSaved = false): Promise<ImageAccountStatus> {
	try {
		if (provider.auth.type === "api-key") {
			if (!ignoreSaved && await readSavedKey(agentDir, provider.id)) return { configured: true, source: "Saved image API Key" };
			if (env[provider.auth.env]?.trim()) {
				validateKey(env[provider.auth.env]!);
				return { configured: true, source: `Environment: ${provider.auth.env}` };
			}
		}
		const id = provider.auth.type === "provider" ? provider.auth.providerId : provider.auth.fallbackProviderId;
		const configured = registry.getProvider(id) !== undefined && registry.getProviderAuthStatus(id).configured;
		return { configured, source: configured ? `Existing Pi provider: ${id}` : "Not configured" };
	} catch {
		return { configured: false, source: "Configuration error", error: "Cannot read this image account. Check its credential file or Provider configuration; no fallback was used." };
	}
}

export async function resolveImageAuth(provider: ImageProviderConfig, agentDir: string, registry: AuthRegistry, env: NodeJS.ProcessEnv = process.env): Promise<ResolvedImageAuth> {
	if (provider.auth.type === "api-key") {
		const saved = await readSavedKey(agentDir, provider.id);
		const key = saved ?? (env[provider.auth.env]?.trim() ? validateKey(env[provider.auth.env]!) : undefined);
		if (key) return { apiKey: key, baseUrl: QWEN_BASE_URL };
	}
	const id = provider.auth.type === "provider" ? provider.auth.providerId : provider.auth.fallbackProviderId;
	const registered = registry.getProvider(id);
	if (!registered) throw new Error(provider.auth.type === "provider"
		? "Install and log in through pi-codex-official first; retry after updating Codex credentials."
		: "Configure a Token Plan CN Key in /image --settings or configure qwen-token-plan-cn.");
	let resolution: Awaited<ReturnType<AuthRegistry["getProviderAuth"]>>;
	try { resolution = await registry.getProviderAuth(id); }
	catch { throw new Error(`Cannot resolve ${id} credentials. Update its login/configuration and retry; no fallback was used.`); }
	if (!resolution?.auth.apiKey) throw new Error(`No credential for ${id}; configure the account and retry.`);
	const baseUrl = resolution.auth.baseUrl ?? registered.baseUrl;
	if (!baseUrl) throw new Error("Image authentication provider has no base URL");
	return { apiKey: resolution.auth.apiKey, baseUrl: requireImageEndpoint(baseUrl, provider.adapter), headers: resolution.auth.headers };
}

export function requireImageEndpoint(value: string, adapter: ImageAdapter): string {
	let url: URL;
	try { url = new URL(value); } catch { throw new Error("Invalid image service endpoint"); }
	const expectedHost = adapter === "openai-codex-images" ? "chatgpt.com" : "token-plan.cn-beijing.maas.aliyuncs.com";
	if (url.protocol !== "https:" || url.hostname !== expectedHost || url.port || url.username || url.password || url.search || url.hash) {
		throw new Error("Image credentials may only be sent to the supported official HTTPS service endpoint");
	}
	// Paths are adapter-owned; the registry may expose the chat-compatible URL.
	if (adapter === "openai-codex-images") {
		if (!["/backend-api", "/backend-api/codex"].includes(url.pathname.replace(/\/+$/, ""))) throw new Error("Unsupported Codex endpoint path");
		return "https://chatgpt.com/backend-api/codex";
	}
	if (!["", "/api/v1", "/compatible-mode/v1"].includes(url.pathname.replace(/\/+$/, ""))) throw new Error("Unsupported Token Plan CN endpoint path");
	return QWEN_BASE_URL;
}

export async function readSavedKey(agentDir: string, providerId: string): Promise<string | undefined> {
	return (await readStore(getCredentialPath(agentDir))).keys[providerId];
}
export async function saveImageKey(agentDir: string, providerId: string, value: string): Promise<void> {
	const key = validateKey(value);
	await updateStore(agentDir, providerId, key);
}
export async function deleteImageKey(agentDir: string, providerId: string): Promise<void> {
	await updateStore(agentDir, providerId, undefined);
}

async function assertSafePath(filePath: string): Promise<void> {
	const absolute = path.resolve(filePath);
	const root = path.parse(absolute).root;
	let current = root;
	for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		try {
			const stats = await lstat(current);
			if (stats.isSymbolicLink() || (stats.isFile() && stats.nlink > 1)) throw new Error("Unsafe credential path");
			if (current !== absolute && !stats.isDirectory()) throw new Error("Unsafe credential directory");
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
}
async function readStore(filePath: string): Promise<Store> {
	try {
		await assertSafePath(filePath);
		const file = await open(filePath, "r");
		let text: string;
		try {
			const stats = await file.stat();
			if (!stats.isFile() || stats.nlink > 1 || stats.size > MAX_STORE_BYTES) throw new Error("Invalid store");
			const buffer = Buffer.alloc(MAX_STORE_BYTES + 1);
			let count = 0;
			while (count < buffer.length) {
				const { bytesRead } = await file.read(buffer, count, buffer.length - count, null);
				if (!bytesRead) break;
				count += bytesRead;
			}
			if (count > MAX_STORE_BYTES) throw new Error("Invalid store");
			text = buffer.subarray(0, count).toString("utf8");
		} finally { await file.close(); }
		const raw = JSON.parse(text);
		if (!raw || raw.version !== 1 || Object.keys(raw).some((k) => !["version", "keys"].includes(k)) || !raw.keys || typeof raw.keys !== "object" || Array.isArray(raw.keys)) throw new Error("Invalid store");
		const keys: Record<string, string> = Object.create(null);
		for (const [id, key] of Object.entries(raw.keys)) {
			if (!safeId(id) || typeof key !== "string") throw new Error("Invalid store");
			keys[id] = validateKey(key);
		}
		return { version: 1, keys };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, keys: Object.create(null) };
		throw new Error("Cannot read image credential file. Check permissions and format; no fallback or overwrite was performed.");
	}
}
function safeId(id: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !["__proto__", "constructor", "prototype"].includes(id); }

async function updateStore(agentDir: string, providerId: string, key: string | undefined): Promise<void> {
	if (!safeId(providerId)) throw new Error("Invalid image credential provider ID");
	const filePath = getCredentialPath(agentDir);
	const directory = path.dirname(filePath);
	let release: (() => Promise<void>) | undefined;
	let temporaryPath: string | undefined;
	try {
		await assertSafePath(filePath);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await assertSafePath(filePath);
		if (process.platform !== "win32") await chmod(directory, 0o700);
		const lockPath = path.join(directory, ".auth.lock");
		await assertSafePath(lockPath);
		let compromised = false;
		release = await lockfile.lock(directory, {
			realpath: false, lockfilePath: lockPath, stale: 10_000,
			retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
			onCompromised: () => { compromised = true; },
		});
		const store = await readStore(filePath);
		if (key === undefined) delete store.keys[providerId];
		else store.keys[providerId] = key;
		const text = `${JSON.stringify(store, null, 2)}\n`;
		if (Buffer.byteLength(text) > MAX_STORE_BYTES) throw new Error("Credential store is full");
		temporaryPath = path.join(directory, `.auth.${randomUUID()}.tmp`);
		const file = await open(temporaryPath, "wx", 0o600);
		try { await file.writeFile(text, "utf8"); await file.sync(); } finally { await file.close(); }
		await assertSafePath(filePath);
		if (compromised) throw new Error("Credential lock was lost");
		await rename(temporaryPath, filePath);
		temporaryPath = undefined;
	} catch {
		throw new Error("Could not update image credentials. Check file permissions/format or retry after another settings operation finishes. Existing credentials were not intentionally replaced on failure.");
	} finally {
		if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
		if (release) await release().catch(() => undefined);
	}
}
