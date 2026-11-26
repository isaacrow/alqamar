// Ensures the Al-Qamar catalog & authority files exist in DATA_DIR before starting the server.
// If missing (e.g. on a fresh cloud container or empty volume), downloads the compressed bundle
// from the GitHub Release and extracts it into DATA_DIR.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT_DIR = path.join(__dirname, "..");
const DATA_DIR = process.env.ALQAMAR_DATA_DIR ? path.resolve(process.env.ALQAMAR_DATA_DIR) : path.join(ROOT_DIR, "data");
const CATALOG_PATH = path.join(DATA_DIR, "dromh_marc21_rda_catalog_v2.jsonl");
const DATA_URL = process.env.ALQAMAR_DATA_URL ||
  "https://github.com/isaacrow/alqamar/releases/download/data-v1/alqamar-data.tar.gz";

async function downloadFile(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Copy bundled small metadata files into external DATA_DIR if needed
  const bundledDir = path.join(ROOT_DIR, "data");
  for (const name of ["analytics_cache.json", "kiqp_manuscripts_cataloging_guide.json"]) {
    const src = path.join(bundledDir, name);
    const dst = path.join(DATA_DIR, name);
    if (src !== dst && fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
    }
  }

  if (fs.existsSync(CATALOG_PATH)) {
    console.log(`[ensure-data] Catalog already present at ${CATALOG_PATH}`);
    return;
  }

  const archivePath = path.join(DATA_DIR, "alqamar-data.tar.gz");
  console.log(`[ensure-data] Downloading catalog bundle from ${DATA_URL}...`);
  await downloadFile(DATA_URL, archivePath);
  console.log(`[ensure-data] Extracting into ${DATA_DIR}...`);
  execFileSync("tar", ["-xzf", archivePath, "-C", DATA_DIR], { stdio: "inherit" });
  fs.unlinkSync(archivePath);
  console.log(`[ensure-data] Ready.`);
}

main().catch((err) => {
  console.error("[ensure-data] Error:", err.message);
  process.exit(1);
});
