// span[role="button"]은 네이티브 버튼과 달리 Enter/Space로 click이 발화되지 않으므로
// 문서 레벨 위임으로 보강한다. (정적 마크업 + 동적 생성된 [role="button"] 모두 커버)
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.defaultPrevented) return;
    const t = e.target;
    if (!t.closest) return;
    if (t.matches('input, textarea, select, button, a[href]') || t.isContentEditable) return;
    const target = t.closest('[role="button"]');
    if (!target) return;
    e.preventDefault();
    target.click();
});
