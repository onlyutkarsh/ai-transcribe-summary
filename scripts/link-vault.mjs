import { existsSync, symlinkSync, mkdirSync, lstatSync, unlinkSync } from "fs";
import { resolve, join } from "path";

const vaultPath = process.argv[2];
if (!vaultPath) {
	console.error("Usage: npm run link:vault -- \"/path/to/YourVault\"");
	process.exit(1);
}

const pluginId = JSON.parse(
	await import("fs").then((fs) => fs.promises.readFile("manifest.json", "utf8"))
).id;

const vaultAbs = resolve(vaultPath);
if (!existsSync(vaultAbs)) {
	console.error(`Vault path does not exist: ${vaultAbs}`);
	process.exit(1);
}

const pluginsDir = join(vaultAbs, ".obsidian", "plugins");
mkdirSync(pluginsDir, { recursive: true });

const target = join(pluginsDir, pluginId);
const source = resolve(".");

if (existsSync(target)) {
	const stat = lstatSync(target);
	if (stat.isSymbolicLink()) {
		unlinkSync(target);
	} else {
		console.error(`${target} already exists and is not a symlink. Remove it manually first.`);
		process.exit(1);
	}
}

symlinkSync(source, target, "dir");
console.log(`Linked ${target} -> ${source}`);
