/**
 * Obsidian's requestUrl() only accepts a string or ArrayBuffer body - no
 * native multipart/form-data support (unlike the DOM fetch/FormData APIs) -
 * so file uploads (Whisper's /audio/transcriptions) need this hand-built.
 */
export interface MultipartField {
	name: string;
	value: string;
}

export interface MultipartFile {
	name: string;
	filename: string;
	mimeType: string;
	data: ArrayBuffer;
}

export interface EncodedMultipart {
	contentType: string;
	body: ArrayBuffer;
}

export function encodeMultipartFormData(fields: MultipartField[], files: MultipartFile[]): EncodedMultipart {
	const boundary = `----AiTranscribeSummary${Date.now()}${Math.random().toString(16).slice(2)}`;
	const encoder = new TextEncoder();
	const parts: Uint8Array[] = [];

	for (const field of fields) {
		parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`));
	}

	for (const file of files) {
		parts.push(
			encoder.encode(
				`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`
			)
		);
		parts.push(new Uint8Array(file.data));
		parts.push(encoder.encode("\r\n"));
	}

	parts.push(encoder.encode(`--${boundary}--\r\n`));

	const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const body = new Uint8Array(totalLength);
	let offset = 0;
	for (const part of parts) {
		body.set(part, offset);
		offset += part.byteLength;
	}

	return { contentType: `multipart/form-data; boundary=${boundary}`, body: body.buffer };
}
