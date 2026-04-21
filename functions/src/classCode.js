// "A103" → { level_symbol: "A", class_number: "103" }
// "101"  → { level_symbol: "", class_number: "101" }
// 첫 영문 연속 prefix를 level_symbol로, 나머지를 class_number로.
export function parseClassCode(code) {
  if (!code) return { level_symbol: '', class_number: '' };
  const m = String(code).match(/^([A-Za-z]*)(.*)$/);
  return { level_symbol: m[1] || '', class_number: m[2] || '' };
}
