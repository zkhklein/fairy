/*
 * 生成 llmtranslate 的 runner.blob.txt：runner.js.txt + shared/srt.js.txt 组合后 gzip+base64。
 * 原因：runner 走 `node -e <脚本>` 命令行启动，Windows CreateProcess 上限 32767 字符
 * （2026-09-18 实测 34,944 字符 ENAMETOOLONG）。改为引导装载后命令行只剩 P 参数 + 压缩 blob。
 * 修改 runner.js.txt / srt.js.txt 后必须重跑本脚本（verify_subtitle_llm.cjs 有过期断言兜底）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = readFileSync(path.join(root, 'plugins-source/subtitle-pipeline/atomic/llmtranslate/runner.js.txt'), 'utf8');
const srt = readFileSync(path.join(root, 'plugins-source/subtitle-pipeline/shared/srt.js.txt'), 'utf8');
const composed = runner.replace('/*__FMB_SRT__*/', () => srt);
const blob = gzipSync(Buffer.from(composed, 'utf8')).toString('base64');
const out = path.join(root, 'plugins-source/subtitle-pipeline/atomic/llmtranslate/runner.blob.txt');
writeFileSync(out, blob, 'utf8');
console.log(`runner.blob.txt: ${blob.length} chars (source ${composed.length} chars, gzip-b64 ratio ${(blob.length / composed.length).toFixed(2)})`);
