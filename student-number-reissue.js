/**
 * student-number-reissue.js — 등록번호(studentNumber) 수동 재발급/변경
 *
 * 등록번호는 최초 발급 후 불변이 원칙(shared deriveStudentNumber)이지만, 학생 본인
 * 휴대폰이 나중에 생기는 등 소스가 바뀌는 경우를 위해 명시적 변경 경로를 둔다.
 *   1) 소스 지정 재발급 — 본인/학부모1/학부모2 번호에서 6자리 파생
 *   2) 직접 입력 — 원하는 6자리 번호로 지정(source='manual')
 * 이름+번호 중복 검사를 통과해야 하며, 이전 번호는 studentNumberHistory에 보관한다.
 * 등록번호는 태블릿 키오스크 로그인 키이므로 변경 시 학생 안내가 필요하다.
 *
 * 진입: window.openStudentNumberReissue(studentId) — 상세 패널 헤더 버튼.
 * 저장 시 상위소스 승격 제안(하이브리드)은 maybeSuggestUpgrade()로 app.js 저장 흐름이 호출.
 */
import { state } from './store.js';
import { db } from './firebase-config.js';
import { doc, collection, serverTimestamp, writeBatch } from 'firebase/firestore';
import { promptModal, confirmModal } from './prompt-modal.js';
import { showToast } from './toast.js';
import {
    deriveFromSource,
    isValidStudentNumber,
    detectStudentNumberUpgrade,
    studentNumberIdentityKey,
    STUDENT_NUMBER_SOURCES,
} from '@impact7/shared/student-number';

const SOURCE_LABELS = {
    student_phone: '본인 휴대폰',
    parent_phone_1: '학부모1',
    parent_phone_2: '학부모2',
    manual: '직접 입력',
};

function sourceLabel(source) {
    return SOURCE_LABELS[source] || '수동';
}

// 이전 등록번호를 studentNumberHistory에 남길 항목. 교체 직전 학생 상태로 만든다.
function historyEntryFor(student) {
    return {
        studentNumber: String(student.studentNumber || ''),
        source: student.studentNumberSource || '',
        replacedAt: new Date().toISOString(),
        replacedBy: state.currentUser?.email || 'system',
    };
}

function findDuplicate(name, studentNumber, excludeId) {
    const key = studentNumberIdentityKey(name, studentNumber);
    if (!key) return null;
    return state.allStudents.find(
        s => s.id !== excludeId && studentNumberIdentityKey(s.name, s.studentNumber) === key,
    ) || null;
}

// Firestore 업데이트 + 로컬 캐시 동기화 + 상세 재렌더. 성공 여부 반환.
async function commitStudentNumber(student, studentNumber, source) {
    const current = String(student.studentNumber || '');
    if (studentNumber === current) {
        showToast('현재 등록번호와 동일합니다.', 'info');
        return false;
    }
    const dup = findDuplicate(student.name, studentNumber, student.id);
    if (dup) {
        showToast(
            `이름+학생번호가 이미 존재합니다.\n\n입력값: ${student.name} #${studentNumber}\n기존 학생: ${dup.name || dup.id} (${dup.status || '상태없음'})\n\n동명이인이면 이름 뒤에 숫자를 붙여 구분하세요.`,
            'warn', { sticky: true },
        );
        return false;
    }
    const historyEntry = current ? historyEntryFor(student) : null;
    const patch = {
        studentNumber,
        studentNumberSource: source,
        studentNumberIssuedAt: serverTimestamp(),
        updated_at: serverTimestamp(),
    };
    if (historyEntry) patch.studentNumberHistory = [...(student.studentNumberHistory || []), historyEntry];

    // 학생 문서 + 감사로그를 한 batch로 원자 처리 — 키오스크 로그인 키 변경은 추적 남긴다.
    try {
        const batch = writeBatch(db);
        batch.set(doc(db, 'students', student.id), patch, { merge: true });
        batch.set(doc(collection(db, 'history_logs')), {
            doc_id: student.id,
            change_type: 'UPDATE',
            before: `등록번호:${current || '없음'} (${sourceLabel(student.studentNumberSource)})`,
            after: `등록번호:${studentNumber} (${sourceLabel(source)})`,
            google_login_id: state.currentUser?.email || 'system',
            timestamp: serverTimestamp(),
        });
        await batch.commit();
    } catch (err) {
        console.error('[studentNumber] 변경 실패:', err);
        showToast('등록번호 변경 실패: ' + (err?.message || err), 'error', { sticky: true });
        return false;
    }

    student.studentNumber = studentNumber;
    student.studentNumberSource = source;
    if (historyEntry) student.studentNumberHistory = patch.studentNumberHistory;

    showToast(`등록번호를 #${studentNumber}(으)로 변경했습니다. 학생에게 새 번호를 안내하세요.`, 'info', { sticky: true });
    if (state.currentStudentId === student.id) window.selectStudent?.(student.id, student);
    return true;
}

async function confirmChange(studentNumber, sourceText) {
    return confirmModal({
        title: '등록번호 변경',
        message: `#${studentNumber} (${sourceText})(으)로 변경할까요?\n\n태블릿 키오스크 로그인 번호가 바뀌므로 학생에게 새 번호를 안내해야 합니다.`,
        confirmText: '변경',
    });
}

// 상세 패널 헤더 버튼 진입점. 인자 생략 시 현재 선택 학생.
window.openStudentNumberReissue = async (studentId = state.currentStudentId) => {
    const student = state.allStudents.find(s => s.id === studentId);
    if (!student) return;

    const derivable = STUDENT_NUMBER_SOURCES
        .map(source => ({ source, number: deriveFromSource(student, source) }))
        .filter(o => o.number);

    const options = derivable.map(o => `${SOURCE_LABELS[o.source]} → #${o.number}`);
    options.push('직접 입력…');

    const currentText = student.studentNumber
        ? `현재 #${student.studentNumber} (${sourceLabel(student.studentNumberSource)})`
        : '현재 미발급';
    const pick = await promptModal({ title: '등록번호 변경', label: '변경 방식', hint: currentText, options });
    if (pick == null) return;

    const idx = Number(pick);
    if (idx < derivable.length) {
        const { source, number } = derivable[idx];
        if (await confirmChange(number, SOURCE_LABELS[source])) {
            await commitStudentNumber(student, number, source);
        }
        return;
    }

    // 직접 입력
    const raw = await promptModal({
        title: '등록번호 직접 입력',
        label: '새 등록번호 (6자리 숫자)',
        placeholder: '예: 123456',
        value: student.studentNumber || '',
    });
    if (raw == null) return;
    const digits = String(raw).replace(/\D/g, '');
    if (!isValidStudentNumber(digits)) {
        showToast('등록번호는 6자리 숫자여야 합니다.', 'warn');
        return;
    }
    if (await confirmChange(digits, '직접 입력')) {
        await commitStudentNumber(student, digits, 'manual');
    }
};

// 하이브리드 제안: 저장 시 현재 소스보다 상위 번호(예: 본인 폰)가 새로 생기면 교체를 제안한다.
// studentData(폼 입력값)에서 감지하고, 수락 시 studentData에 병합할 필드를 반환(불수락/해당없음=null).
// 무음 변경이 아니라 확인 모달을 띄운다. 중복 검사는 app.js 저장 흐름의 기존 가드가 담당.
export async function maybeSuggestUpgrade(studentData, oldStudent) {
    // studentData(폼 입력)에는 studentNumber가 없어 현재 번호를 실어 넘긴다 — 상위소스가
    // 현재와 동일한 번호를 만들 때 no-op 제안이 뜨는 오탐 방지.
    const upgrade = detectStudentNumberUpgrade(
        { ...studentData, studentNumber: oldStudent.studentNumber },
        oldStudent.studentNumberSource,
    );
    if (!upgrade) return null;
    const accepted = await confirmModal({
        title: '등록번호 갱신 제안',
        message: `${sourceLabel(upgrade.source)} 번호가 확인되었습니다.\n등록번호를 #${oldStudent.studentNumber} → #${upgrade.studentNumber}(으)로 바꿀까요?\n\n태블릿 로그인 번호가 바뀌므로 학생 안내가 필요합니다.`,
        confirmText: '갱신',
    });
    if (!accepted) return null;
    return {
        studentNumber: upgrade.studentNumber,
        studentNumberSource: upgrade.source,
        studentNumberIssuedAt: serverTimestamp(),
        studentNumberHistory: [...(oldStudent.studentNumberHistory || []), historyEntryFor(oldStudent)],
    };
}
