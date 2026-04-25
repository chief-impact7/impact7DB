/**
 * store.js — 중앙 상태 관리
 *
 * app.js의 공유 상태를 한곳에 모아 관리한다.
 * 새 모듈은 이 파일에서 상태를 import하고, 변경 시 setter를 사용한다.
 * setter를 통해야 subscribe 리스너가 동작하므로, 직접 mutate는 금지.
 *
 * 사용법:
 *   import { state, update, subscribe } from './store.js';
 *
 *   // 읽기
 *   const students = state.allStudents;
 *
 *   // 쓰기 (변경된 키만 전달)
 *   update({ currentStudentId: 'abc123' });
 *
 *   // 배열 변경 (새 배열로 교체 — 직접 push/splice 금지)
 *   update({ allStudents: [...state.allStudents, newStudent] });
 *
 *   // 구독 (상태 변경 시 콜백)
 *   const unsub = subscribe((newState, changedKeys) => { ... });
 *   unsub(); // 구독 해제
 */

// ── 상태 정의 ──────────────────────────────────────────────────────────
const _savedSemester = localStorage.getItem('semesterFilter');

export const state = {
  currentUser: null,
  currentUserRole: null,       // 'admin' | 'teacher' | null
  currentStudentId: null,
  allStudents: [],
  activeFilters: {
    level: null, branch: null, day: null, status: null,
    class_type: null, class_code: null, leave: null,
    semester: _savedSemester || null, grade: null,
  },
  bulkMode: false,
  selectedStudentIds: new Set(),
  semesterSettings: {},        // semester → { start_date }
  currentSemester: null,
  currentFilteredStudents: null,
  leaveRequests: [],
};

// ── 구독 ────────────────────────────────────────────────────────────────
const _listeners = new Set();

/**
 * 상태 변경 구독. 콜백은 (state, changedKeys) 를 받는다.
 * @returns {Function} 구독 해제 함수
 */
export function subscribe(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

// ── 업데이트 ────────────────────────────────────────────────────────────
/**
 * 상태를 부분 업데이트한다. 변경된 키만 전달.
 *   update({ allStudents: [...state.allStudents, newStudent] });
 *
 * 직접 state.allStudents.push() 하지 말 것 — 리스너가 동작하지 않는다.
 */
export function update(partial) {
  const changedKeys = [];
  for (const key of Object.keys(partial)) {
    if (!(key in state)) {
      console.warn(`[store] unknown key: ${key}`);
      continue;
    }
    if (state[key] !== partial[key]) {
      state[key] = partial[key];
      changedKeys.push(key);
    }
  }
  if (changedKeys.length > 0) {
    for (const cb of _listeners) {
      try { cb(state, changedKeys); } catch (e) { console.error('[store] listener error:', e); }
    }
  }
}
