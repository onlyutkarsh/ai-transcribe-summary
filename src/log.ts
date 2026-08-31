const LOG_PREFIX = "ai-transcribe-summary:";

export function logDebug(...args: unknown[]): void {
	console.debug(LOG_PREFIX, ...args);
}
