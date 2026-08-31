/**
 * Test-only stub for the "obsidian" module. The real package ships type
 * definitions only (no runtime JS - Obsidian itself provides the module at
 * plugin-load time), so any file that imports a runtime symbol from it
 * (Notice, requestUrl, etc.) can't be imported directly in a test without
 * this stub. Extend as tests start exercising files that touch more of the
 * Obsidian API.
 */
export class Notice {
	constructor(_message: string, _duration?: number) {}
}

export function requestUrl(): never {
	throw new Error("requestUrl is not implemented in tests - mock it at the call site instead of hitting this stub.");
}
