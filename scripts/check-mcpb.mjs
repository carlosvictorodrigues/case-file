import { openSync, readSync, statSync, closeSync } from "node:fs";
import { join } from "node:path";

const bundlePath = join(process.cwd(), "case-file.mcpb");

// Entradas sem as quais o bundle instala mas QUEBRA em runtime. O bug de
// campo da v0.3.0 (mcpbignore excluiu sql-wasm.js) só apareceria aqui.
const REQUIRED_ENTRIES = [
  "manifest.json",
  "dist/server.js",
  "node_modules/sql.js-fts5/dist/sql-wasm.js",
  "node_modules/sql.js-fts5/dist/sql-wasm.wasm",
  "node_modules/pdfjs-dist/legacy/build/pdf.mjs",
  "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  "node_modules/pdf-lib/package.json",
  "data/prazos-civel.json",
  "node_modules/zod/package.json",
  "node_modules/@modelcontextprotocol/sdk/package.json",
  "node_modules/docx/package.json",
];

/** Lê os nomes das entradas do zip via central directory (sem dependências). */
function listZipEntries(path) {
  const stat = statSync(path);
  const fd = openSync(path, "r");
  try {
    // End Of Central Directory: procura a assinatura 0x06054b50 no fim.
    const tailSize = Math.min(stat.size, 65_557);
    const tail = Buffer.alloc(tailSize);
    readSync(fd, tail, 0, tailSize, stat.size - tailSize);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("zip EOCD signature not found");
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);

    const names = [];
    let pos = 0;
    while (pos + 46 <= cd.length && cd.readUInt32LE(pos) === 0x02014b50) {
      const nameLen = cd.readUInt16LE(pos + 28);
      const extraLen = cd.readUInt16LE(pos + 30);
      const commentLen = cd.readUInt16LE(pos + 32);
      names.push(cd.toString("utf8", pos + 46, pos + 46 + nameLen));
      pos += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } finally {
    closeSync(fd);
  }
}

try {
  const stat = statSync(bundlePath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error("bundle is empty");
  }
  const entries = new Set(listZipEntries(bundlePath));
  const missing = REQUIRED_ENTRIES.filter((entry) => !entries.has(entry));
  const fontCount = [...entries].filter((name) =>
    name.startsWith("node_modules/pdfjs-dist/standard_fonts/"),
  ).length;
  if (fontCount === 0) missing.push("node_modules/pdfjs-dist/standard_fonts/*");
  if (missing.length) {
    throw new Error(`bundle is missing runtime-critical entries:\n  - ${missing.join("\n  - ")}`);
  }
  console.log(
    `MCPB bundle verified: ${bundlePath} (${stat.size} bytes, ${entries.size} entries, runtime-critical files present)`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MCPB bundle verification failed: ${message}`);
  process.exit(1);
}
