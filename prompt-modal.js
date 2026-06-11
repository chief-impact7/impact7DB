// 네이티브 prompt()/confirm() 대체 — Promise 기반 입력·선택·확인 모달.
// #prompt-modal은 index.html 정적 마크업 (modal-manager 계약: display 토글 + overlay onclick close).
// 반환: input=trim 문자열, select=선택 index 문자열, confirm=boolean. 취소/Esc/배경클릭 = null(confirm은 false).
let _resolve = null;
let _mode = 'input'; // 'input' | 'select' | 'confirm'

const el = (id) => document.getElementById(id);

function close(result) {
    el('prompt-modal').style.display = 'none';
    const resolve = _resolve;
    _resolve = null;
    resolve?.(result);
}

window.closePromptModal = (e) => {
    if (e && e.target !== el('prompt-modal')) return;
    close(_mode === 'confirm' ? false : null);
};

window.confirmPromptModal = () => {
    if (_mode === 'confirm') return close(true);
    if (_mode === 'select') return close(el('prompt-modal-select').value);
    close(el('prompt-modal-input').value.trim());
};

function open({ title, label = '', hint = '', mode, confirmText = '확인', setup = null }) {
    return new Promise((resolve) => {
        if (_resolve) window.closePromptModal(); // 재진입: 앞선 호출을 취소로 정리해 영구 pending 방지
        _resolve = resolve;
        _mode = mode;
        el('prompt-modal-title').textContent = title;
        el('prompt-modal-label').textContent = label;
        el('prompt-modal-hint').textContent = hint;
        const input = el('prompt-modal-input');
        const select = el('prompt-modal-select');
        const ok = el('prompt-modal-ok');
        input.style.display = mode === 'input' ? '' : 'none';
        select.style.display = mode === 'select' ? '' : 'none';
        ok.textContent = confirmText;
        // modal-manager onOpen이 [autofocus]를 우선 포커스 — 모드별 주 컨트롤에 부여
        input.toggleAttribute('autofocus', mode === 'input');
        select.toggleAttribute('autofocus', mode === 'select');
        ok.toggleAttribute('autofocus', mode === 'confirm');
        el('prompt-modal-label').setAttribute('for', mode === 'select' ? 'prompt-modal-select' : 'prompt-modal-input');
        setup?.({ input, select });
        el('prompt-modal').style.display = 'flex';
    });
}

// options 배열을 주면 select(반환값 = 선택 index 문자열), 없으면 텍스트 입력(반환값 = trim된 문자열)
export function promptModal({ title, label = '', hint = '', placeholder = '', options = null, value = '' }) {
    const useSelect = Array.isArray(options);
    return open({
        title, label, hint,
        mode: useSelect ? 'select' : 'input',
        setup({ input, select }) {
            if (useSelect) {
                select.innerHTML = '';
                options.forEach((text, i) => {
                    const op = document.createElement('option');
                    op.value = String(i);
                    op.textContent = text;
                    select.appendChild(op);
                });
            } else {
                input.value = value;
                input.placeholder = placeholder;
            }
        },
    });
}

// 네이티브 confirm() 대체 — 제목 + 본문(message, 줄바꿈 유지)을 보여주고 boolean 반환
export function confirmModal({ title, message = '', confirmText = '확인' }) {
    return open({ title, hint: message, mode: 'confirm', confirmText }).then((v) => v === true);
}

for (const id of ['prompt-modal-input', 'prompt-modal-select']) {
    el(id)?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            window.confirmPromptModal();
        }
    });
}
