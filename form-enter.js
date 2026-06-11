// 폼 텍스트 input에서 Enter로 저장 버튼 클릭 (disabled 가드·연타 방지를 버튼 경유로 보존).
// checkbox/radio(Space 오타)·date(한국어 캘린더 열림 중)·textarea·select는 제외, IME 조합 중 제외.
function wireEnterSubmit(formId, buttonId) {
    document.getElementById(formId)?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing || e.repeat) return;
        if (!e.target.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="date"])')) return;
        if (document.querySelector('.kdp-popover')) return;
        e.preventDefault();
        document.getElementById(buttonId)?.click();
    });
}

wireEnterSubmit('new-student-form', 'save-btn');
wireEnterSubmit('enrollment-form', 'enrollment-save-btn');
