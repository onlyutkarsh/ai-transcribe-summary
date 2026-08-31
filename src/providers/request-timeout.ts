import { RequestUrlParam, RequestUrlResponse, requestUrl } from "obsidian";

/** Thrown when `signal` is aborted while a request is in flight - distinguished from a timeout/network error so callers can treat user-initiated cancellation differently (no error Notice, no rescue-transcript noise). */
export class RequestAbortedError extends Error {
	constructor(message = "Request was cancelled.") {
		super(message);
		this.name = "RequestAbortedError";
	}
}

/**
 * requestUrl has no built-in timeout or cancellation, so a stalled connection (dead socket, proxy
 * that never closes, provider hang) leaves the awaiting call - and the whole pipeline - stuck
 * forever with nothing to stop it. This races the request against a timer and, if given, an
 * AbortSignal, rejecting instead of hanging. Obsidian's requestUrl doesn't expose the underlying
 * connection, so an abort can't actually cut the in-flight HTTP request - it only stops the
 * pipeline from waiting on/using its result once it eventually settles.
 */
export function requestUrlWithTimeout(params: RequestUrlParam, timeoutMs: number, signal?: AbortSignal): Promise<RequestUrlResponse> {
	return new Promise((resolve, reject) => {
		let settled = false;

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			fn();
		};

		const timer = window.setTimeout(() => {
			settle(() => reject(new Error(`Request to ${params.url} timed out after ${Math.round(timeoutMs / 1000)}s`)));
		}, timeoutMs);

		const onAbort = () => settle(() => reject(new RequestAbortedError()));
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort);

		requestUrl(params).then(
			(response) => settle(() => resolve(response)),
			(error) => settle(() => reject(error instanceof Error ? error : new Error(String(error))))
		);
	});
}
