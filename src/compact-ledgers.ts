/**
 * 把既有 ledger 裡的原始事件流壓成 trace，回收 `pi-process-adapter` 開始壓縮之前累積的空間。
 *
 * 刻意與落地路徑共用 `compactPiEvents`：清理腳本若自己實作一套過濾規則，兩邊必然漂移，
 * 最後「磁碟上留了什麼」會有兩個互相矛盾的答案。
 *
 *   node dist/compact-ledgers.js <root> [--apply]
 *
 * 預設只報告會發生什麼事；`--apply` 才實際改寫。這是不可逆操作，砍掉的是串流中間態。
 */
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { compactPiEvents, isPiSessionLog } from "./ledger-retention.js";

interface Reclaimed { before: number; after: number; files: number; }

async function walk(dir: string, onFile: (path: string, name: string, size: number) => Promise<void>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { await walk(path, onFile); continue; }
    if (!entry.isFile()) continue;
    const size = await stat(path).then((info) => info.size).catch(() => 0);
    await onFile(path, entry.name, size);
  }
}

export async function compactLedgers(root: string, apply: boolean, log: (line: string) => void = console.log): Promise<Reclaimed> {
  const totals: Reclaimed = { before: 0, after: 0, files: 0 };
  await walk(root, async (path, name, size) => {
    if (name === "events.jsonl") {
      // 讀進記憶體是刻意的：這些檔案大到需要串流處理時，正確做法是先修落地路徑，
      // 而不是讓清理工具去背負一個本來就不該存在的規模。
      const compacted = compactPiEvents(await readFile(path, "utf8"));
      totals.before += size; totals.after += Buffer.byteLength(compacted, "utf8"); totals.files += 1;
      if (apply) { await writeFile(join(path, "..", "trace.jsonl"), compacted); await rm(path, { force: true }); }
      log(`${apply ? "compact" : "would compact"} ${path} ${(size / 1024 / 1024).toFixed(1)} MB → ${(Buffer.byteLength(compacted, "utf8") / 1024).toFixed(1)} KB`);
      return;
    }
    if (isPiSessionLog(name)) {
      totals.before += size; totals.files += 1;
      if (apply) await rm(path, { force: true });
      log(`${apply ? "remove" : "would remove"} ${path} ${(size / 1024).toFixed(1)} KB`);
    }
  });
  return totals;
}

if (process.argv[1]?.endsWith("compact-ledgers.js")) {
  const root = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!root) { console.error("usage: node dist/compact-ledgers.js <root> [--apply]"); process.exit(2); }
  const totals = await compactLedgers(root, apply);
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  console.log(`\n${apply ? "reclaimed" : "would reclaim"}: ${totals.files} files, ${mb(totals.before)} MB → ${mb(totals.after)} MB`);
  if (!apply) console.log("nothing was changed; pass --apply to rewrite");
}
