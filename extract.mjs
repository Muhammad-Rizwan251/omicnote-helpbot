// OmicNote helpbot: runs a Bioconda tool inside its biocontainers image and saves its real --help text.
// Runs on GitHub Actions (see tool-help.yml). No dependencies: Node 20 + Docker.
//
//   node extract.mjs <bioconda-package-name>
//
// Writes catalog/<name>.json:
//   { name, image, version, binaries: [...], main, help, subs: { sort: "...", index: "..." }, extractedAt }
// Parsing into options/commands happens later in the OmicNote app, so parser improvements apply to old results too.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const name = (process.argv[2] || "").trim().toLowerCase();
if (!/^[a-z0-9][a-z0-9._+-]{0,59}$/.test(name)) { console.error(`Bad tool name: "${name}"`); process.exit(1); }

const MAX = 20000;          // characters kept per help text
const RUNTIMES = /^(python[\d.]*|perl[\d.]*|r|rscript|java|sh|bash|env|.*-config|pip\d*|conda|mamba|2to3.*|idle.*|pydoc.*|easy_install.*|wheel|cpan.*|pod2.*|corelist|h2ph|h2xs|instmodsh|json_pp|libnetcfg|perlbug|perldoc|perlivp|perlthanks|piconv|pl2pm|prove|ptar.*|shasum|splain|xsubpp|zipdetails|enc2xs|encguess|c_rehash|openssl|curl|wget|gzip|gunzip|zcat|bgzip|tabix|htsfile|xz.*|lz.*|bz.*|unxz|xzcat|zstd.*|sqlite3|tclsh.*|wish.*|x86_64-.*|gio.*|glib.*|gdbus.*|gsettings|iconv|locale.*|ldd|tput|tic|toe|tset|infocmp|clear|reset|captoinfo|infotocap|ncurses.*)$/i;

function sh(cmd, args, timeoutMs = 60000) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 << 20 });
  return { code: r.status, out: `${r.stdout || ""}\n${r.stderr || ""}`.trim(), timedOut: r.error?.code === "ETIMEDOUT" };
}

// 1. Latest image tag from quay.io/biocontainers
async function latestImage() {
  const r = await fetch(`https://quay.io/api/v1/repository/biocontainers/${name}/tag/?limit=100&onlyActiveTags=true`);
  if (!r.ok) throw new Error(`No biocontainers image for "${name}" (quay ${r.status})`);
  const tags = (await r.json()).tags || [];
  if (!tags.length) throw new Error(`No image tags for "${name}"`);
  tags.sort((a, b) => (b.start_ts || 0) - (a.start_ts || 0));
  return { image: `quay.io/biocontainers/${name}:${tags[0].name}`, version: tags[0].name.split("--")[0] };
}

let n = 0;
/** Run a command inside the container; stdin is closed so nothing waits for input */
function inContainer(image, argv, timeoutMs = 60000) {
  const cname = `hb_${process.pid}_${n++}`;
  const r = sh("docker", ["run", "--rm", "--name", cname, "--network", "none", "--entrypoint", "", image, ...argv], timeoutMs);
  if (r.timedOut) sh("docker", ["rm", "-f", cname], 20000);
  return r;
}

/** --help, then -h, then no arguments: first output that looks like help */
function helpOf(image, argv) {
  for (const flag of [["--help"], ["-h"], []]) {
    const r = inContainer(image, [...argv, ...flag]);
    const out = r.out.replace(/\x1b\[[0-9;]*m/g, "");
    if (out.length > 60 && !/executable file not found|not found in \$PATH|no such file/i.test(out)) return out.slice(0, MAX);
  }
  return "";
}

/** Sub-commands listed under a "Commands:" / "Available Commands:" heading */
function subcommands(help) {
  const lines = help.split("\n");
  const subs = [];
  let inSection = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^(available |sub-?)?commands?\b.*:?\s*$/i.test(t) || /^(programs|tools|modules):?\s*$/i.test(t)) { inSection = true; continue; }
    if (!inSection) continue;
    // a new non-indented heading ("Options:", "Flags:") ends the list
    if (subs.length && /^\S.*:\s*$/.test(line) && !/command/i.test(line)) break;
    const m = line.match(/^\s{1,10}([a-z][\w.-]{1,30})\s{2,}\S/);
    if (m && !["help", "version", "completion"].includes(m[1]) && !subs.includes(m[1])) subs.push(m[1]);
  }
  return subs.slice(0, 120);
}

const { image, version } = await latestImage();
console.log(`Image: ${image}`);
const pull = sh("docker", ["pull", "-q", image], 15 * 60000);
if (pull.code !== 0) { console.error(pull.out); process.exit(1); }

// 2. Which programs does the package install?
const ls = inContainer(image, ["sh", "-c", "ls -1 /usr/local/bin 2>/dev/null"]).out.split("\n").map((s) => s.trim()).filter(Boolean);
const binaries = ls.filter((b) => !RUNTIMES.test(b) && !/\.(so|a|h|pc|txt|md|jar)$/i.test(b));
const lower = binaries.map((b) => b.toLowerCase());
const main = binaries[lower.indexOf(name)]
  ?? binaries[lower.findIndex((b) => b.replace(/[-_.]/g, "") === name.replace(/[-_.]/g, ""))]
  ?? binaries[lower.findIndex((b) => b.startsWith(name.replace(/\d+$/, "")))]
  ?? null;
console.log(`Main program: ${main ?? "(none matching the package name)"} · ${binaries.length} programs`);

// 3. Help of the main program, then of every sub-command
const help = main ? helpOf(image, [main]) : "";
const subs = {};
for (const s of subcommands(help)) {
  const h = helpOf(image, [main, s]);
  if (h && h !== help) subs[s] = h;
  console.log(`  ${main} ${s}: ${h ? h.length + " chars" : "no help"}`);
}

// 4. Other programs of the package (subread → featureCounts, …): their own help, max 25
const others = {};
for (const b of binaries.filter((x) => x !== main).slice(0, 25)) {
  const h = helpOf(image, [b]);
  if (h) others[b] = h;
}

mkdirSync("catalog", { recursive: true });
writeFileSync(`catalog/${name}.json`, JSON.stringify({ name, image, version, binaries, main, help, subs, others, extractedAt: new Date().toISOString() }, null, 1));
console.log(`Saved catalog/${name}.json (${Object.keys(subs).length} sub-commands, ${Object.keys(others).length} other programs)`);
