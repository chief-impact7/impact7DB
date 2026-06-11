// 네이티브 prompt() 대체 — 텍스트 입력 또는 목록 선택을 Promise로 반환 (취소 시 null).
// #prompt-modal은 index.html 정적 마크업 (modal-manager 계약: display 토글 + overlay onclick close).
let _resolve = null;

const el = (id) => document.getElementById(id);

function close(result) {
    el('prompt-modal').style.display = 'none';
    const resolve = _resolve;
    _resolve = null;
    resolve?.(result);
}

window.closePromptModal = (e) => {
    if (e && e.target !== el('prompt-modal')) return;
    close(null);
};

window.confirmPromptModal = () => {
    const select = el('prompt-modal-select');
    const useSelect = select.style.display !== 'none';
    close(useSelect ? select.value : el('prompt-modal-input').value.trim());
};

// options 배열을 주면 select(반환값 = 선택 index 문자열), 없으면 텍스트 입력(반환값 = trim된 문자열)
export function promptModal({ title, label = '', hint = '', placeholder = '', options = null, value = '' }) {
    return new Promise((resolve) => {
        if (_resolve) close(null); // 재진입: 앞선 호출을 취소로 정리해 영구 pending 방지
        _resolve = resolve;
        el('prompt-modal-title').textContent = title;
        el('prompt-modal-label').textContent = label;
        el('prompt-modal-hint').textContent = hint;
        const input = el('prompt-modal-input');
        const select = el('prompt-modal-select');
        const useSelect = Array.isArray(options);
        input.style.display = useSelect ? 'none' : '';
        select.style.display = useSelect ? '' : 'none';
        // modal-manager onOpen이 [autofocus]를 우선 포커스 — 보이는 컨트롤에 부여
        input.toggleAttribute('autofocus', !useSelect);
        select.toggleAttribute('autofocus', useSelect);
        el('prompt-modal-label').setAttribute('for', useSelect ? 'prompt-modal-select' : 'prompt-modal-input');
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
        el('prompt-modal').style.display = 'flex';
    });
}

for (const id of ['prompt-modal-input', 'prompt-modal-select']) {
    el(id)?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            window.confirmPromptModal();
        }
    });
}
