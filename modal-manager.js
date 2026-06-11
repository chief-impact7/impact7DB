// 모달 공통 매니저 — 정적 .modal-overlay의 display 변경을 감지해
// Esc 닫기·열림 시 포커스 이동·닫힘 시 포커스 복원·Tab 트랩을 일괄 제공한다.
// 호출부 100여 곳의 style.display 직접 토글을 바꾸지 않기 위해 MutationObserver 방식.
//
// 새 모달이 지켜야 할 계약 (벗어나면 이 매니저가 조용히 무시한다):
// 1. 모듈 로드 시점에 index.html 정적 마크업으로 존재하는 .modal-overlay여야 한다 (동적 생성 미관찰)
// 2. inline style.display 'flex'/'none' 토글로 여닫아야 한다 (class 토글 미감지)
// 3. overlay 자신을 target으로 한 클릭에 닫히는 onclick close 핸들러가 있어야 Esc가 동작한다
const FOCUSABLE = 'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

const openStack = []; // { overlay, opener }

function visibleFocusables(root) {
    return [...root.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null && !el.disabled);
}

function onOpen(overlay) {
    openStack.push({ overlay, opener: document.activeElement });
    const card = overlay.querySelector('.modal-card') || overlay;
    const target = overlay.querySelector('[autofocus]') || visibleFocusables(card)[0];
    if (target) {
        target.focus();
    } else {
        card.setAttribute('tabindex', '-1');
        card.focus();
    }
}

function onClose(idx) {
    const { opener } = openStack.splice(idx, 1)[0];
    if (opener?.isConnected && opener.offsetParent !== null) opener.focus?.();
}

const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
        const overlay = m.target;
        // 기본 CSS가 display:flex이므로 inline 'none'만 닫힘으로 판정
        const open = overlay.style.display !== 'none';
        const idx = openStack.findIndex(s => s.overlay === overlay);
        if (open && idx === -1) onOpen(overlay);
        else if (!open && idx !== -1) onClose(idx);
    }
});

document.querySelectorAll('.modal-overlay').forEach(el =>
    observer.observe(el, { attributes: true, attributeFilter: ['style'] }));

// busy 모달은 배경 클릭 닫기도 차단 — capture 단계라 overlay의 inline onclick보다 먼저 실행됨
document.addEventListener('click', (e) => {
    if (e.target.classList?.contains('modal-overlay') && e.target.dataset.busy) {
        e.stopPropagation();
    }
}, true);

document.addEventListener('keydown', (e) => {
    const top = openStack[openStack.length - 1]?.overlay;
    if (!top) return;

    if (e.key === 'Escape') {
        if (e.isComposing) return; // IME 조합 취소 Esc가 모달을 닫으면 안 됨
        // Chromium은 열린 select/date picker를 Esc로 닫을 때 keydown을 페이지에도 전파한다
        if (e.target.matches?.('select, input[type="date"], input[type="month"]')) return;
        if (document.querySelector('.kdp-popover')) return; // 한국어 캘린더가 열려 있으면 그쪽만 닫는다
        if (top.dataset.busy) return; // 비동기 작업 진행 중 — 닫으면 취소된 것으로 오인
        e.preventDefault();
        top.click(); // 배경 클릭과 동일 경로 — 각 모달의 close 함수가 상태 정리까지 수행
        return;
    }

    if (e.key !== 'Tab') return;
    const focusables = visibleFocusables(top);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!top.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
});
