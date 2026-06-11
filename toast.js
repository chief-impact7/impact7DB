const DURATION = { success: 3500, info: 3500, warn: 5000, error: 6000 };
const ICON = { success: 'check_circle', info: 'info', warn: 'warning', error: 'error' };

let container = null;

function ensureContainer() {
    if (container) return container;
    container = document.createElement('div');
    container.className = 'toast-container';
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
    return container;
}

// sticky: 자동소멸 없이 클릭으로만 닫음 — 사용자가 읽고 조치해야 하는 장문 진단·차단 사유용
export function showToast(message, type = 'info', { sticky = false } = {}) {
    if (!DURATION[type]) type = 'info';
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    if (type === 'error') el.setAttribute('role', 'alert');

    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = ICON[type];

    const text = document.createElement('span');
    text.className = 'toast-message';
    text.textContent = message;

    el.append(icon, text);
    if (sticky) {
        const closeBtn = document.createElement('span');
        closeBtn.className = 'material-symbols-outlined toast-close';
        closeBtn.setAttribute('aria-hidden', 'true');
        closeBtn.textContent = 'close';
        el.appendChild(closeBtn);
        el.title = '클릭하여 닫기';
    }
    ensureContainer().appendChild(el);

    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        el.classList.add('toast--hide');
        el.addEventListener('transitionend', () => el.remove(), { once: true });
        setTimeout(() => el.remove(), 400);
    };
    el.addEventListener('click', close);
    const timer = sticky ? null : setTimeout(close, DURATION[type]);
    return el;
}
