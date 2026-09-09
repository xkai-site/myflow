import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sanitizeDiagnosticText } from "./errors.ts";
import type { NetworkTrace } from "./network-trace.ts";

export interface ErrorCauseDetail {
	at: string;
	name: string;
	message: string;
	code?: string;
	syscall?: string;
}
export interface ImageRequestDiagnostic {
	version: 1;
	id: string;
	timestamp: string;
	operation: "generate" | "edit" | "download";
	phase: "connect" | "response";
	host: string;
	method: string;
	model?: string;
	elapsedMs: number;
	status?: number;
	requestId?: string;
	imagegenRequestId?: string;
	outcome?: "success" | "error";
	network?: NetworkTrace;
	settings?: { size: string; quality: string; referenceCount: number };
	causes: ErrorCauseDetail[];
	hint: string;
}
export type DiagnosticWriter = (diagnostic: ImageRequestDiagnostic) => Promise<string>;

/** No arbitrary object serialization, stack, headers, socket or request/response bodies. */
export function collectErrorCauses(error: unknown, secrets: readonly string[] = []): ErrorCauseDetail[] {
	const causes: ErrorCauseDetail[] = [];
	const seen = new Set<object>();
	function visit(value: unknown, at: string, depth: number): void {
		if (causes.length >= 12 || depth > 6) return;
		if (!value || typeof value !== "object") {
			causes.push({ at, name: "Error", message: typeof value === "string" ? sanitizeDiagnosticText(value, secrets) : "Unknown error" });
			return;
		}
		if (seen.has(value)) return;
		seen.add(value);
		const object = value as Record<string, unknown>;
		causes.push({
			at,
			name: sanitizeDiagnosticText(typeof object.name === "string" ? object.name : "Error", secrets, 48),
			message: sanitizeDiagnosticText(typeof object.message === "string" ? object.message : "Unknown error", secrets),
			...(typeof object.code === "string" ? { code: sanitizeDiagnosticText(object.code, secrets, 64) } : {}),
			...(typeof object.syscall === "string" ? { syscall: sanitizeDiagnosticText(object.syscall, secrets, 32) } : {}),
		});
		if (object.cause !== undefined) visit(object.cause, `${at}.cause`, depth + 1);
		if (Array.isArray(object.errors)) {
			for (const [index, nested] of object.errors.slice(0, 12).entries()) visit(nested, `${at}.errors[${index}]`, depth + 1);
		}
	}
	visit(error, "error", 0);
	return causes;
}

export function diagnosticHint(causes: readonly ErrorCauseDetail[], status?: number): string {
	const codes = causes.map((cause) => cause.code ?? "").join(" ");
	if (/ENOTFOUND|EAI_AGAIN/.test(codes)) return "DNS 解析失败：检查网络、DNS 和代理设置。";
	if (/CERT_|TLS_|SSL_|SELF_SIGNED|UNABLE_TO_VERIFY/.test(codes)) return "TLS 校验失败：检查系统时间、代理证书和受信任 CA；不要关闭证书校验。";
	if (/TIMEOUT|ETIMEDOUT/.test(codes) || causes.some((cause) => cause.name === "TimeoutError")) return "请求超时：检查代理和网络；服务端可能已处理请求，请先确认额度或结果再重试。";
	if (/UND_ERR_SOCKET/.test(codes)) return "连接被对端关闭：服务端、代理或模型/请求兼容性均可能导致；检查本次模型和参数，并先确认服务端结果再重试。";
	if (/ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/.test(codes)) return "连接失败或中断：检查代理是否运行、防火墙和网络连通性；请先确认服务端结果再重试。";
	if (status === 401) return "认证被拒绝：检查所选账户并更新登录或 Key。";
	if (status === 403) return "访问被拒绝：检查账户权限、模型可用性及代理/网关限制。";
	if (status === 429) return "请求受限：检查额度和限流状态，稍后再试。";
	if (status && status >= 500) return "服务端或网关异常：请先确认服务端结果，稍后再试。";
	if (causes.some((cause) => /redirect/i.test(cause.message))) return "请求发生重定向，已为保护认证信息而阻止；检查服务地址和代理。";
	return "查看诊断日志中的原因链；检查网络、代理及服务状态，不要反复提交生图请求。";
}

export function formatRequestDiagnostic(diagnostic: ImageRequestDiagnostic): string {
	const operation = { generate: "生成请求", edit: "编辑请求", download: "图片下载" }[diagnostic.operation];
	const codes = [...new Set(diagnostic.causes.map((cause) => cause.code).filter(Boolean))].slice(0, 3).join(", ");
	const reason = diagnostic.causes.at(-1)?.message || diagnostic.causes[0]?.name || "Unknown error";
	return `${operation}失败 · ${diagnostic.host} · ${diagnostic.phase === "connect" ? "等待响应头（连接/发送/服务端处理）" : "响应读取"}\n${diagnostic.status === undefined ? "未收到 HTTP 响应" : `HTTP ${diagnostic.status}`}${codes ? ` · ${codes}` : ""}\n${reason.slice(0, 180)}\n${diagnostic.hint}`;
}

export function newDiagnosticId(): string { return randomUUID(); }

/** Unique, private, atomic, best-effort logs; caller must never mask the original error. */
export function createDiagnosticWriter(cwd: string): DiagnosticWriter {
	return async (diagnostic) => {
		const root = path.resolve(cwd, ".pi");
		const directory = path.join(root, "image-generation-logs");
		for (const candidate of [root, directory]) {
			try {
				const stats = await lstat(candidate);
				if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("Unsafe diagnostic directory");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await mkdir(candidate, { recursive: true, mode: 0o700 });
		}
		// Filenames are locally generated, never derived from an error or upstream ID.
		const filename = `${diagnostic.outcome === "success" ? "success" : "error"}-${randomUUID()}.json`;
		const finalPath = path.join(directory, filename);
		const temporaryPath = path.join(directory, `.${filename}.tmp`);
		try {
			await writeFile(temporaryPath, `${JSON.stringify({ ...diagnostic, runtime: { node: process.version, platform: process.platform, arch: process.arch } }, null, 2)}\n`, { flag: "wx", mode: 0o600, encoding: "utf8" });
			await rename(temporaryPath, finalPath);
		} catch (error) {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
			throw error;
		}
		return path.join(".pi", "image-generation-logs", filename);
	};
}
