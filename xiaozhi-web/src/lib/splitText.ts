/**
 * 长文本按句拆分（聊天气泡分段显示用）。
 *
 * 把一段长回复按语义边界拆成多条短文本，每条对应一个气泡：
 *  - 优先在句子结束标点（。！？；以及英文 .!?;）处断开；
 *  - 单句过长（无标点）时按最大长度硬切兜底，避免气泡撑满整屏。
 */
const SENTENCE_RE = /[^。！？；.!?;]+[。！？；.!?;]?/g;
const MAX_LEN = 60;

export function splitLongText(text: string): string[] {
  const cleaned = (text ?? '').trim();
  if (!cleaned) return [];
  if (cleaned.length <= MAX_LEN) return [cleaned];

  const segs = cleaned.match(SENTENCE_RE) ?? [cleaned];
  const out: string[] = [];
  let cur = '';

  const flush = (s: string) => {
    while (s.length > MAX_LEN) {
      out.push(s.slice(0, MAX_LEN));
      s = s.slice(MAX_LEN);
    }
    if (s) out.push(s);
  };

  for (const seg of segs) {
    if ((cur + seg).length <= MAX_LEN) {
      cur += seg;
    } else {
      if (cur) out.push(cur);
      flush(seg);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [cleaned];
}
