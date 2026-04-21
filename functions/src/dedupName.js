const ACTIVE = new Set(['재원', '등원예정']);

// 활성 학생 중 동명이인이 있으면 숫자 접미사 붙인 이름 반환, 없으면 null.
export function deduplicateName(selfId, currentName, allStudents) {
  if (!currentName) return null;
  const isDup = allStudents.some(s =>
    s.id !== selfId && s.name === currentName && ACTIVE.has(s.status)
  );
  if (!isDup) return null;

  const base = currentName.replace(/\d+$/, '');
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}\\d*$`);
  const variants = allStudents.filter(s =>
    s.id !== selfId && re.test(s.name) && ACTIVE.has(s.status)
  );
  const used = variants.map(s => {
    const m = s.name.match(/(\d+)$/);
    return m ? parseInt(m[1], 10) : 1;
  });
  used.push(1);
  // max + 1 전략 (의도적): 빈 번호를 채우지 않음. 재사용 혼동 방지.
  return `${base}${Math.max(...used) + 1}`;
}
