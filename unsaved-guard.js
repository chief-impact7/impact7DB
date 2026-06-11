// 학생 상세/등록 폼의 미저장 변경 추적.
// 동적 enrollment 입력까지 잡기 위해 form이 아닌 #detail-form 패널에서 위임 수신.
// 폼 밖 모달(수업 추가 등)에서 폼 데이터를 바꾸는 경로는 markFormDirty()를 직접 호출한다.
const panel = document.getElementById('detail-form');
let dirty = false;

function formVisible() {
    return !!panel && panel.style.display !== 'none';
}

export function markFormDirty() { dirty = true; }
export function markFormClean() { dirty = false; }
export function hasUnsavedChanges() { return dirty && formVisible(); }

// true = 진행 가능 (변경 없음 또는 사용자가 버리기로 확인)
export function confirmDiscardUnsaved() {
    if (!hasUnsavedChanges()) return true;
    const ok = confirm('저장하지 않은 변경사항이 있습니다.\n저장하지 않고 나가시겠습니까?');
    if (ok) dirty = false;
    return ok;
}

panel?.addEventListener('input', markFormDirty);
document.getElementById('new-student-form')?.addEventListener('reset', markFormClean);

window.addEventListener('beforeunload', (e) => {
    if (!hasUnsavedChanges()) return;
    e.preventDefault();
    e.returnValue = '';
});
