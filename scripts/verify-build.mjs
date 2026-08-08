import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const manifestPath = resolve(root, "dist", "manifest.json");
const contentPath = resolve(root, "dist", "content.js");
const backgroundPath = resolve(root, "dist", "background.js");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const contentSource = await readFile(contentPath, "utf8");
const backgroundSource = await readFile(backgroundPath, "utf8");
const builtFiles = await readdir(resolve(root, "dist"), {
  recursive: true,
  withFileTypes: true
});
const javascriptSources = await Promise.all(
  builtFiles
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) =>
      readFile(resolve(entry.parentPath, entry.name), "utf8")
    )
);

if (!manifest.permissions?.includes("scripting")) {
  throw new Error("Production manifest is missing the scripting permission.");
}
if (!manifest.permissions?.includes("webNavigation")) {
  throw new Error(
    "Production manifest is missing the webNavigation permission required for frame discovery."
  );
}
for (const origin of ["http://*/*", "https://*/*"]) {
  if (!manifest.optional_host_permissions?.includes(origin)) {
    throw new Error(
      `Production manifest is missing optional host access for ${origin}.`
    );
  }
}
if (!javascriptSources.some((source) => source.includes('"content.js"'))) {
  throw new Error(
    "Production background bundle does not reference the packaged content script."
  );
}
for (const requiredFragment of [
  "chrome.webNavigation.getAllFrames",
  "frameIds",
  "FRAME_SCAN_PARTIAL",
  "[scan:aggregate]"
]) {
  if (!backgroundSource.includes(requiredFragment)) {
    throw new Error(
      `Production background bundle is missing frame-scanning fragment: ${requiredFragment}.`
    );
  }
}

try {
  // executeScript({ files }) evaluates this artifact as a classic script.
  // Parsing it this way catches accidental Rollup chunk imports at build time.
  Function(contentSource);
} catch (error) {
  throw new Error(
    `Production content.js is not a self-contained classic script: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
}

console.info(
  "[build:verify] manifest permissions, content path, classic-script bundle, and multi-frame scanner are valid."
);
