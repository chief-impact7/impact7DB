// Firestore Timestamp / Date / epoch ms / ISO 문자열 → epoch millis. 변환 불가 시 null.
// 자동화 스케줄·skip 판정 등 여러 핸들러가 같은 변환을 쓰므로 공용화(중첩 삼항 중복 제거).
export function tsToMillis(value) {
  if (value == null) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') {
    const d = value.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : null;
  }
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
