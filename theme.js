import { msIcon } from './ms-icon.js';
// 다크모드 토글 — 초기 적용은 index.html head 인라인 스니펫(FOUC 방지)이 담당.
// 여기서는 버튼 아이콘 동기화와 전환만 처리한다.
const KEY = 'impact7db-theme';

function syncIcon() {
    const btn = document.getElementById('theme-toggle-btn');
    if (!btn) return;
    const name = document.documentElement.dataset.theme === 'dark' ? 'light_mode' : 'dark_mode';
    btn.outerHTML = msIcon(name, 'icon-btn', 'id="theme-toggle-btn" title="테마 전환" aria-label="테마 전환" role="button" tabindex="0" onclick="window.toggleTheme()"');
}

window.toggleTheme = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch { /* 사생활 모드 등 저장 불가 시 세션 한정 */ }
    syncIcon();
};

syncIcon();
