import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureSafeOutputDirectory } from "./video-files.ts";
import type { StoredVideoTask, VideoTaskType } from "./types.ts";

const MAX_TASK_STORE_BYTES = 1024 * 1024;
const STATUSES = new Set(["PENDING", "RUNNING", "UNKNOWN"]);
const TASK_TYPES = new Set<VideoTaskType>(["t2v", "i2v", "r2v"]);

interface TaskStore {
	version: 1;
	tasks: StoredVideoTask[];
}

export function getTaskStorePath(cwd: string): string {
	return path.resolve(cwd, ".pi", "generated-videos", ".tasks.json");
}

export async function listStoredTasks(cwd: string): Promise<StoredVideoTask[]> {
	return (await readTaskStore(cwd)).tasks.sort((left, right) => right.createdAt - left.createdAt);
}

export async function findStoredTask(cwd: string, taskId: string): Promise<StoredVideoTask | undefined> {
	return (await readTaskStore(cwd)).tasks.find((task) => task.taskId === taskId);
}

export async function upsertStoredTask(cwd: string, task: StoredVideoTask): Promise<void> {
	validateStoredTask(task, "task");
	await withTaskStoreLock(cwd, async () => {
		const store = await readTaskStore(cwd);
		const index = store.tasks.findIndex((item) => item.taskId === task.taskId);
		if (index >= 0) store.tasks[index] = task;
		else store.tasks.push(task);
		await writeTaskStore(cwd, store);
	});
}

export async function removeStoredTask(cwd: string, taskId: string): Promise<void> {
	validateTaskId(taskId, "taskId");
	await withTaskStoreLock(cwd, async () => {
		const store = await readTaskStore(cwd);
		const tasks = store.tasks.filter((task) => task.taskId !== taskId);
		if (tasks.length === store.tasks.length) return;
		if (tasks.length === 0) {
			await rm(getTaskStorePath(cwd), { force: true });
			return;
		}
		await writeTaskStore(cwd, { version: 1, tasks });
	});
}

async function readTaskStore(cwd: string): Promise<TaskStore> {
	const filePath = getTaskStorePath(cwd);
	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, tasks: [] };
		throw error;
	}
	if (Buffer.byteLength(text) > MAX_TASK_STORE_BYTES) throw new Error("Video task store exceeds 1 MB");
	let raw: unknown;
	try {
		raw = JSON.parse(text) as unknown;
	} catch {
		throw new Error("Video task store contains invalid JSON");
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Video task store must be an object");
	const object = raw as Record<string, unknown>;
	if (object.version !== 1 || !Array.isArray(object.tasks)) throw new Error("Video task store has an unsupported schema");
	const tasks = object.tasks.map((value, index) => validateStoredTask(value, `tasks[${index}]`));
	const ids = new Set<string>();
	for (const task of tasks) {
		if (ids.has(task.taskId)) throw new Error(`Video task store contains duplicate task ${task.taskId}`);
		ids.add(task.taskId);
	}
	return { version: 1, tasks };
}

async function writeTaskStore(cwd: string, store: TaskStore): Promise<void> {
	const filePath = getTaskStorePath(cwd);
	const directory = path.dirname(filePath);
	await ensureSafeOutputDirectory(cwd, directory);
	const temporaryPath = path.join(directory, `.tasks.json.${randomUUID()}.tmp`);
	const serialized = `${JSON.stringify(store, null, 2)}\n`;
	if (Buffer.byteLength(serialized) > MAX_TASK_STORE_BYTES) throw new Error("Video task store exceeds 1 MB");
	try {
		await writeFile(temporaryPath, serialized, { flag: "wx", mode: 0o600 });
		await rename(temporaryPath, filePath);
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

function validateStoredTask(value: unknown, location: string): StoredVideoTask {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object`);
	const object = value as Record<string, unknown>;
	const taskId = validateTaskId(object.taskId, `${location}.taskId`);
	const providerId = requiredId(object.providerId, `${location}.providerId`);
	const modelId = requiredId(object.modelId, `${location}.modelId`);
	const task = requiredString(object.task, `${location}.task`) as VideoTaskType;
	if (!TASK_TYPES.has(task)) throw new Error(`${location}.task is invalid`);
	if (!Number.isSafeInteger(object.createdAt) || (object.createdAt as number) <= 0) {
		throw new Error(`${location}.createdAt must be a positive integer`);
	}
	const status = requiredString(object.status, `${location}.status`) as StoredVideoTask["status"];
	if (!STATUSES.has(status)) throw new Error(`${location}.status is invalid`);
	if (!object.parameters || typeof object.parameters !== "object" || Array.isArray(object.parameters)) {
		throw new Error(`${location}.parameters must be an object`);
	}
	const parameters: Record<string, string | number | boolean> = {};
	for (const [key, parameter] of Object.entries(object.parameters as Record<string, unknown>)) {
		if (typeof parameter !== "string" && typeof parameter !== "number" && typeof parameter !== "boolean") {
			throw new Error(`${location}.parameters.${key} must be a scalar`);
		}
		parameters[key] = parameter;
	}
	return {
		taskId,
		providerId,
		modelId,
		task,
		createdAt: object.createdAt as number,
		status,
		parameters,
	};
}

async function withTaskStoreLock<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
	const filePath = getTaskStorePath(cwd);
	await ensureSafeOutputDirectory(cwd, path.dirname(filePath));
	const lockPath = `${filePath}.lock`;
	const deadline = Date.now() + 10_000;
	while (true) {
		try {
			await mkdir(lockPath);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const lockStats = await stat(lockPath).catch(() => undefined);
			if (lockStats && Date.now() - lockStats.mtimeMs > 120_000) {
				await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
				continue;
			}
			if (Date.now() >= deadline) throw new Error("Timed out waiting for the video task-store lock");
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
	}
	try {
		return await operation();
	} finally {
		await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
	}
}

function validateTaskId(value: unknown, location: string): string {
	const result = requiredString(value, location);
	if (result.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result)) {
		throw new Error(`${location} is not a valid task identifier`);
	}
	return result;
}

function requiredString(value: unknown, location: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${location} must be a non-empty string`);
	return value.trim();
}

function requiredId(value: unknown, location: string): string {
	const result = requiredString(value, location);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(result)) throw new Error(`${location} contains invalid characters`);
	return result;
}
