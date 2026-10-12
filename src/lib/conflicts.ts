// 枠を登録するときの「スペースが空いているか」の判定。

export type Range = { start: Date; end: Date };

/** スペースカレンダー上の予定。fromApp はこのシステムが書き込んだ予定かどうか */
export type CalEvent = Range & { id: string; fromApp: boolean };

export function overlaps(a: Range, b: Range) {
  return a.start < b.end && b.start < a.end;
}

/**
 * 候補の時間帯について、
 * - busy: このシステム以外の予定（または有効な枠の予定）と重なっている
 * - orphanIds: このシステムが書き込んだが、どの枠にも対応していない「取り残された仮押さえ」
 *   （登録処理が途中で止まった場合などに残る。新しい枠を作るときに片付ける）
 * referencedIds は、有効な枠に紐づいている予定 ID の一覧。
 */
export function classifyConflicts(slot: Range, events: CalEvent[], referencedIds: Set<string>) {
  const hits = events.filter((e) => overlaps(slot, e));
  const orphanIds = hits.filter((e) => e.fromApp && !referencedIds.has(e.id)).map((e) => e.id);
  const busy = hits.some((e) => !e.fromApp || referencedIds.has(e.id));
  return { busy, orphanIds };
}
