import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");
const output = resolve(root, "../generated-artifacts/chrome-extension");
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
execFileSync("pnpm", ["run", "build"], { cwd: root, stdio: "inherit" });
const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) throw new Error("Package and manifest versions must match.");
mkdirSync(output, { recursive: true });
mkdirSync(join(dist, "icons"), { recursive: true });

// Original caption-symbol icons. PNG encoding uses only Node built-ins.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function icon(size) {
  const rgba = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size, v = (y + 0.5) / size;
    const inPanel = u > 0.16 && u < 0.84 && v > 0.24 && v < 0.76;
    const inLine = (v > 0.42 && v < 0.48 && u > 0.27 && u < 0.73) ||
      (v > 0.56 && v < 0.62 && u > 0.27 && u < 0.62);
    const color = inLine ? [17, 64, 114, 255] : inPanel ? [255, 255, 255, 255] : [17, 64, 114, 255];
    const index = y * (size * 4 + 1) + 1 + x * 4;
    rgba.set(color, index);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(rgba)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
manifest.icons = {};
for (const size of [16, 32, 48, 128]) {
  const name = `icon-${size}.png`;
  writeFileSync(join(dist, "icons", name), icon(size));
  manifest.icons[size] = `icons/${name}`;
}
manifest.action.default_icon = { 16: manifest.icons[16], 32: manifest.icons[32] };
writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// Preserve installed runtime dependency notices without relying on private files
// elsewhere in the workspace. Node-only transitive dependencies may be listed.
function packageRoot(name, fromRequire) {
  let location;
  try { location = fromRequire.resolve(`${name}/package.json`); }
  catch { location = fromRequire.resolve(name); }
  let directory = dirname(location);
  for (;;) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) {
      const data = JSON.parse(readFileSync(candidate, "utf8"));
      if (data.name === name) return { directory, data };
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate package root: ${name}`);
    directory = parent;
  }
}
const visited = new Set(), notices = [], unresolved = [];
function visit(name, fromRequire, optional = false) {
  let found;
  try { found = packageRoot(name, fromRequire); }
  catch (error) {
    if (!optional) throw error;
    unresolved.push(name);
    return;
  }
  const { directory, data } = found;
  const key = `${data.name}@${data.version}`;
  if (visited.has(key)) return;
  visited.add(key);
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice)([.-]|$)/i.test(entry.name));
  notices.push(`\n${"=".repeat(72)}\n${key}\nDeclared licence: ${JSON.stringify(data.license || "not specified")}\n`);
  if (!files.length) notices.push("No top-level licence/notice file found. Review upstream terms before submission.\n");
  for (const entry of files) {
    notices.push(`\n--- ${entry.name} ---\n${readFileSync(join(directory, entry.name), "utf8")}\n`);
  }
  const nested = createRequire(join(directory, "package.json"));
  for (const dependency of Object.keys(data.dependencies || {})) {
    visit(dependency, nested, dependency in (data.optionalDependencies || {}));
  }
  for (const dependency of Object.keys(data.optionalDependencies || {})) visit(dependency, nested, true);
}
visit("@huggingface/transformers", require);
const noticeText = [
  "THIRD-PARTY RUNTIME DEPENDENCY NOTICES\n",
  "Generated conservatively from the installed Transformers dependency graph.\n",
  "Includes dependencies that may not be present in the browser bundle. This is not a complete legal audit.\n",
  "Model assets are downloaded separately: https://huggingface.co/onnx-community/whisper-small\n",
  "Review the model card, upstream licence and any separately required attribution before distribution.\n",
  "These notices do not assign a licence to this project's own source code.\n",
  ...notices,
  `\nUninstalled optional dependencies: ${[...new Set(unresolved)].join(", ") || "none"}\n`,
].join("");
writeFileSync(join(dist, "THIRD_PARTY_NOTICES.txt"), noticeText);

// Check the actual candidate, including packaged runtimes, before making ZIPs.
execFileSync("pnpm", ["run", "test:bundle"], { cwd: root, stdio: "inherit" });
for (const file of [manifest.background.service_worker, manifest.action.default_popup,
  ...manifest.content_scripts.flatMap((entry) => entry.js), ...Object.values(manifest.icons)]) {
  if (!existsSync(join(dist, file))) throw new Error(`Missing packaged resource: ${file}`);
}

const kit = join(output, "publishing-kit");
mkdirSync(kit, { recursive: true });
for (const name of ["STORE-LISTING.md", "PRIVACY-POLICY.md", "RELEASE-CHECKLIST.md", "MAC-APP-STORE-LISTING.md"]) {
  copyFileSync(join(root, "release", name), join(kit, name));
}
copyFileSync(join(dist, "THIRD_PARTY_NOTICES.txt"), join(kit, "THIRD_PARTY_NOTICES.txt"));
for (const size of [16, 32, 48, 128]) {
  copyFileSync(join(dist, "icons", `icon-${size}.png`), join(kit, `icon-${size}.png`));
}
const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
function htmlDocument(name, title) {
  const text = readFileSync(join(root, "release", name), "utf8");
  const content = text.split("\n").map((line) => {
    const heading = /^(#{1,3}) (.*)/.exec(line);
    if (heading) return `<h${heading[1].length}>${escape(heading[2])}</h${heading[1].length}>`;
    return line ? `<p>${escape(line)}</p>` : "";
  }).join("\n");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{max-width:800px;margin:48px auto;padding:0 24px;font:16px/1.6 system-ui,sans-serif;color:#172535;background:#fff}h1{font-size:30px;line-height:1.2}h2{margin-top:32px;font-size:22px}p{overflow-wrap:anywhere}p:first-of-type{padding:16px;background:#fff4d6;border-left:4px solid #976700}@media print{body{margin:0}}</style><main>${content}</main></html>`;
}
for (const [source, filename, title] of [
  ["PRIVACY-POLICY.md", "privacy-policy-draft.html", "Privacy policy draft"],
  ["STORE-LISTING.md", "store-listing-draft.html", "Chrome Web Store listing draft"],
  ["MAC-APP-STORE-LISTING.md", "mac-app-store-listing-draft.html", "Mac App Store listing draft"],
]) {
  const html = htmlDocument(source, title);
  writeFileSync(join(output, filename), html);
  writeFileSync(join(kit, filename), html);
}
function zip(directory, target) {
  execFileSync("python", ["-c", `
import pathlib, sys, zipfile
root, target = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for file in sorted(root.rglob("*")):
        if file.is_file():
            archive.write(file, file.relative_to(root).as_posix())
with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None
    assert all(not n.startswith("/") and ".." not in pathlib.PurePosixPath(n).parts for n in archive.namelist())
`, directory, target], { stdio: "inherit" });
}
const storeZip = join(output, `youtube-english-subtitles-${manifest.version}-store.zip`);
zip(dist, storeZip);
const checksum = createHash("sha256").update(readFileSync(storeZip)).digest("hex");
const checksumText = `${checksum}  youtube-english-subtitles-${manifest.version}-store.zip\n`;
writeFileSync(join(output, "SHA256SUMS.txt"), checksumText);
writeFileSync(join(kit, "SHA256SUMS.txt"), checksumText);
zip(kit, join(output, `youtube-english-subtitles-${manifest.version}-publishing-kit.zip`));
console.log(`Release candidate written to ${output}\nSHA-256: ${checksum}\nDraft fields, store images and real Chrome verification remain required. Nothing was published.`);
