/**
 * Splits a reply into parts for the cloud voice: a short first part (so speech starts quickly),
 * then whole sentences of up to ~350 characters each.
 */
export function speechParts(text: string): string[] {
  const sentences = text.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g)?.map((x) => x.trim()).filter(Boolean) ?? [text];
  const parts: string[] = [];
  let cur = '';
  for (const sn of sentences) {
    const limit = parts.length === 0 ? 140 : 350;
    if (cur && (cur + ' ' + sn).length > limit) {
      parts.push(cur);
      cur = sn;
    } else cur = cur ? `${cur} ${sn}` : sn;
  }
  if (cur) parts.push(cur);
  return parts.length ? parts : [text];
}
