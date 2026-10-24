// OmicNote helpbot: records a tool's real --help text (and every sub-command's). Runs on GitHub Actions (tool-help.yml).
// No dependencies: Node 20 + Docker.
//
//   node extract.mjs seqkit                 Bioconda package → its biocontainers image
//   node extract.mjs gh__owner__repo        GitHub-only tool → clone, install inside a container, then run it
//
// Writes catalog/<key>.json:
//   { name, key, method, image, version, repo?, binaries, main, help, subs: { sort: "…" }, others: { prog: "…" }, extractedAt }
// Parsing into options/commands happens later in the OmicNote app, so parser improvements apply to old results too.
//
// Safety for GitHub repos: their code is only ever run inside throw-away containers that get no tokens and no
// access to this workspace. Help is read with --network none.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const key = (process.argv[2] || "").trim().toLowerCase();
if (!/^[a-z0-9][a-z0-9._+-]{0,99}$/.test(key)) fail(`Bad tool key: "${key}"`);

const MAX = 20000;          // characters kept per help text
const RUNTIMES = /^(python[\d.]*(-config)?|perl[\d.]*|r|rscript|java|javac|sh|bash|dash|env|.*-config|pip\d*(\.\d+)?|conda|mamba|micromamba|2to3.*|idle.*|pydoc.*|easy_install.*|wheel|normalizer|cpan.*|pod2.*|corelist|h2ph|h2xs|instmodsh|json_pp|libnetcfg|perlbug|perldoc|perlivp|perlthanks|piconv|pl2pm|prove|ptar.*|shasum|splain|xsubpp|zipdetails|enc2xs|encguess|c_rehash|openssl|curl|wget|gzip|gunzip|zcat|bgzip|tabix|htsfile|xz.*|lz.*|bz.*|unxz|xzcat|zstd.*|sqlite3|tclsh.*|wish.*|x86_64-.*|gio.*|glib.*|gdbus.*|gsettings|iconv|locale.*|ldd|tput|tic|toe|tset|infocmp|clear|reset|captoinfo|infotocap|ncurses.*|cargo|rustc|rustup|rustdoc|rust-.*|go|gofmt|f2py|cython.*|py\.test|pytest|docutils|rst2.*|pygmentize|jupyter.*|ipython.*|markdown.*|tqdm|chardetect|httpx|distro|numpy-config|isympy|fonttools|pyftmerge|pyftsubset|ttx|nosetests)$/i;

function fail(msg) { console.error(msg); process.exit(1); }
function sh(cmd, args, timeoutMs = 60000, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 << 20, ...opts });
  return { code: r.status, out: `${r.stdout || ""}\n${r.stderr || ""}`.trim(), timedOut: r.error?.code === "ETIMEDOUT" };
}

let n = 0;
/** Run a command inside the image; stdin closed (nothing waits for input), no network */
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
    if (out.length > 60 && !/executable file not found|not found in \$PATH|no such file|exec format error|Traceback \(most recent/i.test(out)) return out.slice(0, MAX);
  }
  return "";
}

/** Sub-commands listed under a "Commands:" / "Available Commands:" heading */
function subcommands(help) {
  const subs = [];
  let inSection = false;
  for (const line of help.split("\n")) {
    const t = line.trim();
    if (/^(available |sub-?)?commands?\b.*:?\s*$/i.test(t) || /^(programs|tools|modules):?\s*$/i.test(t)) { inSection = true; continue; }
    if (!inSection) continue;
    if (subs.length && /^\S.*:\s*$/.test(line) && !/command/i.test(line)) break;   // "Options:", "Flags:" end the list
    const m = line.match(/^\s{1,10}([a-z][\w.-]{1,30})\s{2,}\S/);
    if (m && !["help", "version", "completion"].includes(m[1]) && !subs.includes(m[1])) subs.push(m[1]);
  }
  return subs.slice(0, 120);
}

const listBin = (image) => inContainer(image, ["sh", "-c", "ls -1 /usr/local/bin 2>/dev/null"]).out.split("\n").map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------- Bioconda: ready biocontainers image
async function fromBioconda(name) {
  const r = await fetch(`https://quay.io/api/v1/repository/biocontainers/${name}/tag/?limit=100&onlyActiveTags=true`);
  if (!r.ok) fail(`No biocontainers image for "${name}" (quay ${r.status})`);
  const tags = ((await r.json()).tags || []).sort((a, b) => (b.start_ts || 0) - (a.start_ts || 0));
  if (!tags.length) fail(`No image tags for "${name}"`);
  const image = `quay.io/biocontainers/${name}:${tags[0].name}`;
  console.log(`Image: ${image}`);
  const pull = sh("docker", ["pull", "-q", image], 15 * 60000);
  if (pull.code !== 0) fail(pull.out);
  return { name, image, version: tags[0].name.split("--")[0], method: "bioconda", binaries: listBin(image).filter((b) => !RUNTIMES.test(b) && !/\.(so|a|h|pc|txt|md|jar)$/i.test(b)) };
}

// ---------------------------------------------------------------- GitHub: clone, pick an install method, build an image
async function fromGitHub(owner, repo) {
  const src = `/tmp/hb_src`;
  const clone = sh("git", ["clone", "--depth", "1", `https://github.com/${owner}/${repo}.git`, src], 10 * 60000);
  if (clone.code !== 0) fail(`Could not clone ${owner}/${repo}: ${clone.out}`);
  const has = (f) => existsSync(`${src}/${f}`);
  const top = readdirSync(src);
  const name = repo.toLowerCase();

  // Base image + install command, tried in this order
  let base, install, method;
  if (has("Dockerfile")) method = "dockerfile";
  else if (has("pyproject.toml") || has("setup.py") || has("setup.cfg")) {
    method = "pip"; base = "python:3.11-slim";
    install = "apt-get update -qq && apt-get install -y -qq --no-install-recommends gcc g++ make git zlib1g-dev >/dev/null; pip install --no-cache-dir -q .";
  } else if (has("Cargo.toml")) {
    method = "cargo"; base = "rust:1-slim";
    install = "apt-get update -qq && apt-get install -y -qq pkg-config libssl-dev zlib1g-dev >/dev/null; cargo install --quiet --path . --root /usr/local";
  } else if (has("go.mod")) {
    method = "go"; base = "golang:1.22";
    install = "GOBIN=/usr/local/bin go install ./... 2>&1 | tail -5";
  } else if (has("CMakeLists.txt") || has("Makefile") || has("makefile")) {
    method = "make"; base = "gcc:13";
    const build = has("CMakeLists.txt")
      ? "apt-get update -qq && apt-get install -y -qq cmake zlib1g-dev >/dev/null; cmake -S . -B build -DCMAKE_BUILD_TYPE=Release >/dev/null && cmake --build build -j4"
      : "apt-get update -qq && apt-get install -y -qq zlib1g-dev libbz2-dev liblzma-dev >/dev/null; make -j4";
    // copy every compiled program (ELF file with exec bit) into /usr/local/bin
    install = `${build}; find . -maxdepth 4 -type f -perm -u+x -exec sh -c 'head -c4 "$1" | grep -q ELF && cp "$1" /usr/local/bin/' _ {} \\;`;
  } else {
    // Linux binary in the latest release?
    const rel = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, { headers: { "User-Agent": "omicnote-helpbot" } });
    const assets = rel.ok ? (await rel.json()).assets || [] : [];
    const asset = assets.find((a) => /linux/i.test(a.name) && /(x86_64|amd64|x64)/i.test(a.name)) || assets.find((a) => /linux/i.test(a.name));
    if (asset) {
      method = "release"; base = "ubuntu:24.04";
      install = `apt-get update -qq && apt-get install -y -qq curl ca-certificates unzip >/dev/null; mkdir -p /opt/r && cd /opt/r && curl -sL -o a "${asset.browser_download_url}" && (tar xf a 2>/dev/null || unzip -q a 2>/dev/null || chmod +x a) ; find /opt/r -type f -perm -u+x -exec cp {} /usr/local/bin/ \\; ; [ -f /opt/r/a ] && cp /opt/r/a /usr/local/bin/${name} || true`;
    } else {
      // scripts with a shebang (tool.py, tool.pl, tool.sh, tool.R)
      const scripts = top.filter((f) => /\.(py|pl|sh|r)$/i.test(f) || f.toLowerCase() === name).filter((f) => { try { return readFileSync(`${src}/${f}`, "utf8").startsWith("#!"); } catch { return false; } });
      if (!scripts.length) fail(`Don't know how to install ${owner}/${repo} (no Dockerfile, Python/Rust/Go/C project, Linux release or script). Paste its --help in OmicNote instead.`);
      method = "script"; base = "python:3.11-slim";
      const req = has("requirements.txt") ? "pip install --no-cache-dir -q -r requirements.txt;" : "";
      install = `apt-get update -qq && apt-get install -y -qq perl r-base-core >/dev/null 2>&1; ${req} for f in ${scripts.map((s) => `'${s.replace(/'/g, "")}'`).join(" ")}; do chmod +x "$f"; cp "$f" /usr/local/bin/; cp "$f" "/usr/local/bin/$(basename "$f" | sed 's/\\.[^.]*$//')"; done`;
    }
  }
  console.log(`Install method: ${method}`);

  const image = `hb_built_${name.replace(/[^a-z0-9]/g, "")}`;
  let before = [];
  if (method === "dockerfile") {
    const b = sh("docker", ["build", "-q", "-t", image, src], 30 * 60000);
    if (b.code !== 0) fail(`docker build failed:\n${b.out.slice(-3000)}`);
  } else {
    sh("docker", ["pull", "-q", base], 10 * 60000);
    before = listBin(base);
    // install WITH network, in a container that only sees the cloned code
    const cname = `hb_build_${process.pid}`;
    const b = sh("docker", ["run", "--name", cname, "-v", `${src}:/src`, "-w", "/src", base, "sh", "-c", install], 40 * 60000);
    console.log(b.out.slice(-2000));
    if (b.code !== 0 && method !== "make") fail(`Install failed (${method})`);
    sh("docker", ["commit", cname, image], 5 * 60000);
    sh("docker", ["rm", "-f", cname], 60000);
  }
  const after = listBin(image);
  const fresh = after.filter((b) => !before.includes(b) && !RUNTIMES.test(b) && !/\.(so|a|h|pc|txt|md|jar|dll)$/i.test(b));
  return { name, image, version: "latest", method, repo: `${owner}/${repo}`, binaries: fresh.length ? fresh : after.filter((b) => !RUNTIMES.test(b)) };
}

// ---------------------------------------------------------------- main
const gh = key.match(/^gh__([a-z0-9-]+)__([a-z0-9._-]+)$/);
const info = gh ? await fromGitHub(gh[1], gh[2]) : await fromBioconda(key);
const { image, binaries, name } = info;

const lower = binaries.map((b) => b.toLowerCase());
const stem = name.replace(/[-_.]/g, "");
const main = binaries[lower.indexOf(name)]
  ?? binaries[lower.findIndex((b) => b.replace(/\.(py|pl|sh|r)$/, "") === name)]
  ?? binaries[lower.findIndex((b) => b.replace(/[-_.]/g, "") === stem)]
  ?? binaries[lower.findIndex((b) => b.startsWith(name.replace(/\d+$/, "")))]
  ?? (binaries.length === 1 ? binaries[0] : null);
console.log(`Main program: ${main ?? "(none matching the name)"} · ${binaries.length} programs: ${binaries.slice(0, 20).join(", ")}`);

const help = main ? helpOf(image, [main]) : "";
const subs = {};
for (const s of subcommands(help)) {
  const h = helpOf(image, [main, s]);
  if (h && h !== help) subs[s] = h;
  console.log(`  ${main} ${s}: ${h ? h.length + " chars" : "no help"}`);
}
// Other programs of the package (subread → featureCounts, …), max 25
const others = {};
for (const b of binaries.filter((x) => x !== main).slice(0, 25)) {
  const h = helpOf(image, [b]);
  if (h) others[b] = h;
}
if (!help && !Object.keys(others).length) fail("Installed, but no program printed any help.");

mkdirSync("catalog", { recursive: true });
writeFileSync(`catalog/${key}.json`, JSON.stringify({ ...info, key, main, help, subs, others, extractedAt: new Date().toISOString() }, null, 1));
console.log(`Saved catalog/${key}.json (${info.method}; ${Object.keys(subs).length} sub-commands, ${Object.keys(others).length} other programs)`);
