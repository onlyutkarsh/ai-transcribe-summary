import { existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, join } from "path";

const vaultPath = process.argv[2];
if (!vaultPath) {
	console.error('Usage: npm run link:hotreload -- "/path/to/YourVault"');
	process.exit(1);
}

const vaultAbs = resolve(vaultPath);
if (!existsSync(vaultAbs)) {
	console.error(`Vault path does not exist: ${vaultAbs}`);
	process.exit(1);
}

const targetDir = join(vaultAbs, ".obsidian", "plugins", "hot-reload");
mkdirSync(targetDir, { recursive: true });

const files = ["main.js", "manifest.json"];
for (const file of files) {
	const url = `https://raw.githubusercontent.com/pjeby/hot-reload/master/${file}`;
	const res = await fetch(url);
	if (!res.ok) {
		console.error(`Failed to download ${file}: ${res.status} ${res.statusText}`);
		process.exit(1);
	}
	const text = await res.text();
	writeFileSync(join(targetDir, file), text);
	console.log(`Wrote ${join(targetDir, file)}`);
}

console.log("\nHot-Reload installed. Now in Obsidian: Settings -> Community Plugins -> refresh -> enable 'Hot Reload'.");
