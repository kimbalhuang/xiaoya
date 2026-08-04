// 冒烟脚本：验证 src/lib/splitText.ts 的 splitLongText 切分逻辑。
// 纯逻辑验证，无需浏览器/前端依赖。
//
// 说明：项目 package.json 为 "type": "commonjs"，Node 22 的
// --experimental-strip-types 无法对 .ts 做命名导出检测（会报
// "does not provide an export named ..."）。因此这里用项目自带的
// TypeScript 编译器（node_modules/typescript）把真实源码转译后加载，
// 保证测的是线上代码而非复制逻辑。
//
// 运行：node test/splitText.smoke.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

// 读取真实源码并转译为 ESM JS
const src = readFileSync(new URL('../src/lib/splitText.ts', import.meta.url), 'utf8');
const out = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
  fileName: 'splitText.ts',
}).outputText;

const dataUrl = 'data:text/javascript;base64,' + Buffer.from(out).toString('base64');
const { splitLongText, SPLIT_THRESHOLD, MIN_SEGMENT_LENGTH } = await import(dataUrl);

let failures = 0;

function assert(cond, msg) {
  if (cond) {
    console.log('  PASS:', msg);
  } else {
    failures += 1;
    console.error('  FAIL:', msg);
  }
}

function checkSegments(name, segments, original) {
  console.log(`\n[${name}]`);
  console.log('  段数 =', segments.length);
  segments.forEach((s, i) => console.log(`  seg[${i}] (${s.length}): ${JSON.stringify(s)}`));
  assert(Array.isArray(segments), `${name}: 返回数组`);
  assert(segments.every((s) => s.length > 0), `${name}: 每段非空`);
  assert(segments.every((s) => s.trim().length > 0), `${name}: 无空白段`);
  assert(segments.join('') === original, `${name}: 拼接后与原文一致（不丢字）`);
  return segments;
}

// ---- 用例 1：短文本（≤ 阈值）应保持单段 ----
{
  const text = '好呀好呀，我来帮你放《星光引航》喔！'; // 18 字符
  const segs = checkSegments('短文本', splitLongText(text), text);
  assert(segs.length === 1 && segs[0] === text, '短文本: 单段且内容不变');
  assert(text.length <= SPLIT_THRESHOLD, `短文本: 长度 ${text.length} <= 阈值 ${SPLIT_THRESHOLD}`);
}

// ---- 用例 2：含换行的长歌词（按行切分，换行保留在段尾）----
{
  const line1 = '《星光引航》';
  const line2 = '第一句歌词内容'.repeat(6); // 42 字符
  const line3 = '第二句歌词内容'.repeat(6); // 42 字符
  const text = `${line1}\n${line2}\n${line3}`; // 共 92 字符 > 阈值
  const segs = checkSegments('长歌词(按\\n)', splitLongText(text), text);
  assert(segs.length === 3, '长歌词: 拆成 3 段（按行）');
  assert(segs[0] === `${line1}\n`, '长歌词: 第 1 段以 \\n 结尾');
  assert(segs[1] === `${line2}\n`, '长歌词: 第 2 段以 \\n 结尾');
  assert(segs[2] === line3, '长歌词: 第 3 段为最后一行（无 \\n）');
}

// ---- 用例 3：无换行、含句读的长文本（按句切分，句读保留在段尾）----
{
  const s1 = '这是一句比较长的歌词句子内容'.repeat(2); // 28 字符
  const s2 = '这是另一句比较长的歌词句子内容'.repeat(2); // 28 字符
  const s3 = '这是第三句比较长的歌词句子内容'.repeat(2); // 28 字符
  const text = `${s1}。${s2}！${s3}？`; // 共 87 字符 > 阈值
  const segs = checkSegments('长文本(按句读)', splitLongText(text), text);
  assert(segs.length === 3, '长文本: 拆成 3 段（按句）');
  assert(segs[0].endsWith('。'), '长文本: 第 1 段句读 。 保留在段尾');
  assert(segs[1].endsWith('！'), '长文本: 第 2 段句读 ！ 保留在段尾');
  assert(segs[2].endsWith('？'), '长文本: 第 3 段句读 ？ 保留在段尾');
}

// ---- 用例 4：无换行、无句读的超长文本（60 字符硬切兜底）----
{
  const text = 'x'.repeat(200);
  const segs = checkSegments('硬切兜底', splitLongText(text), text);
  assert(segs.length === 4, `硬切: 200 字符拆成 4 段（60/60/60/20），实际 ${segs.length}`);
  assert(segs.every((s) => s.length <= SPLIT_THRESHOLD), '硬切: 每段长度不超过阈值');
  assert(segs[0].length === SPLIT_THRESHOLD, `硬切: 第 1 段恰为 ${SPLIT_THRESHOLD} 字符`);
  assert(segs[2].length === SPLIT_THRESHOLD, `硬切: 第 3 段恰为 ${SPLIT_THRESHOLD} 字符`);
  assert(segs[3].length === 20, '硬切: 最后一段为剩余 20 字符');
}

// ---- 用例 5：过短段并入前一段（避免碎段）----
{
  const text = '甲'.repeat(58) + '。乙丙'; // 61 字符 > 阈值，句读后跟 2 字符短尾巴
  const segs = checkSegments('过短段合并', splitLongText(text), text);
  assert(segs.length === 1, '过短段: 2 字符的「乙丙」并入前一段，最终 1 段');
  assert(segs[0] === text, '过短段: 合并后内容与原文一致');
}

// ---- 用例 6：61 个无句读字符（硬切出 1 字符尾段后被合并）----
{
  const text = 'a'.repeat(61);
  const segs = checkSegments('61字符硬切+合并', splitLongText(text), text);
  assert(segs.length === 1, '61字符: 1 字符尾段并入前一段，避免单字气泡');
}

// ---- 用例 7：换行 + 超长行（先按行、行内再按句读的级联切分）----
{
  const lineA = '第一行歌词'.repeat(10); // 50 字符
  const lineB = '第二行歌词'.repeat(10); // 50 字符
  const lineC = '第三行歌词'.repeat(10); // 50 字符
  const text = `${lineA}。${lineB}\n${lineC}`; // 首行 101 字符含句读 + 换行 + 50 字符行
  const segs = checkSegments('换行+超长行级联', splitLongText(text), text);
  assert(segs.length === 3, '级联: 拆成 3 段');
  assert(segs[0] === `${lineA}。`, '级联: 第 1 段为句读切出的整句');
  assert(segs[1] === `${lineB}\n`, '级联: 第 2 段以 \\n 结尾');
  assert(segs[2] === lineC, '级联: 第 3 段为最后一行');
}

// ---- 用例 8：边界——恰好 60 字符不切分 ----
{
  const text = 'a'.repeat(SPLIT_THRESHOLD);
  const segs = checkSegments('恰好60字符', splitLongText(text), text);
  assert(segs.length === 1 && segs[0] === text, '恰好60字符: 单段不变');
}

// ---- 用例 9：边界——空文本返回空数组 ----
{
  const segs = splitLongText('');
  console.log('\n[空文本]');
  assert(Array.isArray(segs) && segs.length === 0, '空文本: 返回空数组（不渲染空气泡）');
}

// ---- 用例 10：无换行、无句读的连续中文歌词（歌词语义分段，QQ 音乐式短段）----
{
  const text =
    '街角遇见那晚风正微凉你眼睁藏着整片海洋指尖无意碰触心跳声响像迷失的船帆随风飘荡夜色铺满温柔的光你牵着我走向未知方向把星光酿成行囊一路跌撞也敢去闯'; // 72 字符
  const segs = checkSegments('歌词语义分段', splitLongText(text), text);
  assert(segs.length >= 4, `歌词: 段数 ${segs.length} >= 4（QQ 音乐式多短段）`);
  assert(segs.every((s) => s.length >= 6 && s.length <= 24), '歌词: 每段长度 ∈ [6, 24]');
  console.log('  每段长度 =', segs.map((s) => s.length).join(', '));
}

// ---- 用例 11：无句读但含逗号/顿号的连续中文（仍走歌词语义分段，逗号后优先断句）----
{
  const phrase = '春风吹过山岗，夜色温柔流淌，星光洒满归途，一路跌撞也敢闯'; // 28 字符
  const text = phrase.repeat(3); // 84 字符 > 阈值，无句读
  const segs = checkSegments('歌词(含逗号)', splitLongText(text), text);
  assert(segs.length >= 4, '含逗号歌词: 拆成多段');
  assert(segs.every((s) => s.length >= 6 && s.length <= 24), '含逗号歌词: 每段长度 ∈ [6, 24]');
}

console.log('\n====================');
if (failures === 0) {
  console.log(`ALL PASS：${SPLIT_THRESHOLD} 阈值 / ${MIN_SEGMENT_LENGTH} 合并阈值，全部断言通过`);
  process.exit(0);
} else {
  console.error(`FAILED：${failures} 个断言未通过`);
  process.exit(1);
}
