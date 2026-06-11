// ─── 한국어 캘린더 팝오버 ────────────────────────────────────────────────────
// native input[type=date]의 팝업 캘린더는 페이지 lang이 아니라 브라우저 UI 언어를
// 따라 영문으로 떠서 직접 구현으로 대체한다. impact7newDSC/date-picker.js 이식본.
// DB 변경점: shared todayKST 사용, min/max 지원, input[type=date] 전역 위임(파일 하단).

import { todayKST } from '@impact7/shared/datetime';

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDate = (y, m0, d) => `${y}-${pad2(m0 + 1)}-${pad2(d)}`;

const STYLE = `
.kdp-popover {
  position: fixed;
  z-index: 1200;
  width: 252px;
  padding: 10px;
  background: var(--surface-container, #fff);
  border: 1px solid var(--border, #dde3da);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  font-size: 13px;
  user-select: none;
}
.kdp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.kdp-title { font-weight: 700; font-size: 14px; }
.kdp-nav {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 50%;
  background: none;
  font-size: 18px;
  cursor: pointer;
  color: var(--text-sec, #444);
}
.kdp-nav:hover { background: rgba(0, 0, 0, 0.06); }
.kdp-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}
.kdp-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 30px;
}
.kdp-dow { font-size: 11px; font-weight: 600; color: #888; }
.kdp-day {
  border: none;
  border-radius: 50%;
  background: none;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-main, #222);
}
.kdp-day:hover { background: rgba(0, 0, 0, 0.07); }
.kdp-day:disabled { color: var(--outline, #ccc); cursor: default; background: none; }
.kdp-sun { color: var(--danger-strong, #d93025); }
.kdp-sat { color: #1a73e8; }
.kdp-today { font-weight: 700; box-shadow: inset 0 0 0 1px var(--primary, #00754A); }
.kdp-selected, .kdp-selected:hover { background: var(--primary, #00754A); color: #fff; }
.kdp-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border, #eee);
}
.kdp-today-btn {
  border: none;
  background: none;
  color: var(--primary, #00754A);
  font-weight: 600;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 12px;
  cursor: pointer;
}
.kdp-today-btn:hover { background: rgba(0, 117, 74, 0.08); }
.kdp-today-btn:disabled { color: #ccc; cursor: default; background: none; }
`;

let _cleanup = null;
let _openAnchor = null;

export function closeKoreanDatePicker() {
    if (_cleanup) {
        _cleanup();
        _cleanup = null;
        _openAnchor = null;
    }
}

export function openKoreanDatePicker(anchorEl, valueStr, onSelect, { min = null, max = null } = {}) {
    // 같은 앵커 재클릭은 토글로 동작
    if (_openAnchor === anchorEl) {
        closeKoreanDatePicker();
        return;
    }
    closeKoreanDatePicker();

    if (!document.getElementById('kdp-style')) {
        const st = document.createElement('style');
        st.id = 'kdp-style';
        st.textContent = STYLE;
        document.head.appendChild(st);
    }

    const today = todayKST();
    const inRange = (ds) => (!min || ds >= min) && (!max || ds <= max);
    const selected = /^\d{4}-\d{2}-\d{2}$/.test(valueStr || '') ? valueStr : today;
    let viewY = Number(selected.slice(0, 4));
    let viewM = Number(selected.slice(5, 7)) - 1;

    const pop = document.createElement('div');
    pop.className = 'kdp-popover';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', '날짜 선택');

    const render = () => {
        const firstDow = new Date(viewY, viewM, 1).getDay();
        const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
        let cells = '';
        for (let i = 0; i < firstDow; i++) cells += '<span class="kdp-cell"></span>';
        for (let d = 1; d <= daysInMonth; d++) {
            const ds = fmtDate(viewY, viewM, d);
            const dow = (firstDow + d - 1) % 7;
            const cls = ['kdp-cell', 'kdp-day'];
            if (dow === 0) cls.push('kdp-sun');
            if (dow === 6) cls.push('kdp-sat');
            if (ds === today) cls.push('kdp-today');
            if (ds === selected) cls.push('kdp-selected');
            const dis = inRange(ds) ? '' : ' disabled';
            cells += `<button type="button" class="${cls.join(' ')}" data-date="${ds}"${dis}>${d}</button>`;
        }
        pop.innerHTML = `
            <div class="kdp-header">
                <button type="button" class="kdp-nav" data-nav="-1" aria-label="이전 달">‹</button>
                <span class="kdp-title">${viewY}년 ${viewM + 1}월</span>
                <button type="button" class="kdp-nav" data-nav="1" aria-label="다음 달">›</button>
            </div>
            <div class="kdp-grid">${DAY_NAMES.map((d, i) =>
                `<span class="kdp-cell kdp-dow${i === 0 ? ' kdp-sun' : i === 6 ? ' kdp-sat' : ''}">${d}</span>`).join('')}</div>
            <div class="kdp-grid">${cells}</div>
            <div class="kdp-footer">
                <button type="button" class="kdp-today-btn"${inRange(today) ? '' : ' disabled'}>오늘</button>
            </div>
        `;
    };

    pop.addEventListener('click', (e) => {
        const nav = e.target.closest('[data-nav]');
        if (nav) {
            viewM += Number(nav.dataset.nav);
            if (viewM < 0) { viewM = 11; viewY -= 1; }
            if (viewM > 11) { viewM = 0; viewY += 1; }
            render();
            return;
        }
        const day = e.target.closest('[data-date]');
        if (day) {
            closeKoreanDatePicker();
            onSelect(day.dataset.date);
            return;
        }
        if (e.target.closest('.kdp-today-btn')) {
            closeKoreanDatePicker();
            onSelect(today);
        }
    });

    render();
    document.body.appendChild(pop);

    const r = anchorEl.getBoundingClientRect();
    // 아래 공간이 부족하면 앵커 위로 플립
    let top = r.bottom + 6;
    if (top + pop.offsetHeight > window.innerHeight - 8) {
        top = Math.max(8, r.top - pop.offsetHeight - 6);
    }
    pop.style.top = `${top}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8))}px`;

    const onDocDown = (e) => {
        if (pop.contains(e.target) || anchorEl.contains(e.target)) return;
        // 닫는 클릭이 아래 UI(모달 배경 onclick 등)에 닿아 모달까지 닫지 않도록 1회 삼킨다
        const swallow = (ce) => ce.stopPropagation();
        document.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 100);
        closeKoreanDatePicker();
    };
    const onKey = (e) => {
        if (e.key === 'Escape') closeKoreanDatePicker();
    };
    // 스크롤되는 페이지에서 앵커와 분리된 채 떠 있지 않도록 닫는다
    const onScroll = (e) => {
        if (!pop.contains(e.target)) closeKoreanDatePicker();
    };
    // 팝오버를 연 클릭 자체에 닫히지 않도록 다음 틱에 등록
    const timer = setTimeout(() => {
        document.addEventListener('mousedown', onDocDown);
        document.addEventListener('keydown', onKey);
        document.addEventListener('scroll', onScroll, true);
    }, 0);

    _openAnchor = anchorEl;
    _cleanup = () => {
        clearTimeout(timer);
        document.removeEventListener('mousedown', onDocDown);
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('scroll', onScroll, true);
        pop.remove();
    };
}

// ─── input[type=date] 전역 위임 ─────────────────────────────────────────────
// 정적·동적 생성을 불문하고 모든 date input 클릭 시 한국어 캘린더를 연다.
// pointerType 가드로 마우스 좌클릭만 가로챈다 — 터치는 OS native picker(한국어 OS)
// 그대로, 세그먼트 클릭 캐럿·키보드 타이핑도 보존(preventDefault 안 함).
// Firefox는 자체 캘린더 아이콘을 CSS로 숨길 수 없어 아이콘 클릭 시 native와 겹칠 수 있음.
// 선택값은 input/change dispatch로 unsaved-guard dirty 추적·기존 핸들러와 연동.
document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const input = e.target.closest?.('input[type="date"]');
    if (!input || input.disabled || input.readOnly) return;
    openKoreanDatePicker(input, input.value, (ds) => {
        // min/max는 열린 동안 바뀔 수 있으므로(applyDateConstraints) 선택 시점에 재검증
        if ((input.min && ds < input.min) || (input.max && ds > input.max)) return;
        input.value = ds;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { min: input.min || null, max: input.max || null });
});
