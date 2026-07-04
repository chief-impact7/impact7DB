import { initializeApp } from 'firebase/app';
import { getAuth, initializeAuth, inMemoryPersistence, onIdTokenChanged } from 'firebase/auth';
import { initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';

const firebaseConfig = {
    apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

// 진단용: 환경변수 로딩 확인 (개발 중에만 사용)
if (import.meta.env.DEV) {
    const missing = Object.entries(firebaseConfig)
        .filter(([, v]) => !v)
        .map(([k]) => k);
    if (missing.length > 0) {
        console.error('[Firebase] .env에서 누락된 값:', missing);
    } else {
        console.log('[Firebase] 설정 로딩 완료 ✓', {
            projectId: firebaseConfig.projectId,
            authDomain: firebaseConfig.authDomain,
            apiKeyLen:  firebaseConfig.apiKey?.length,
            apiKeyTail: '...' + firebaseConfig.apiKey?.slice(-6),
        });
    }
}

// 두 앱 체제:
// - [DEFAULT] app: auth 전담 — 같은 origin의 모든 impact7 앱이 동일 auth 저장 키를
//   공유해 한 번 로그인으로 전체 사용 (원앱 SSO).
// - 'db' app: Firestore persistence 분리 — [DEFAULT] IndexedDB 공유 시 다른 앱 탭과
//   primary lease 충돌로 write가 hang됨.
const app = initializeApp(firebaseConfig);
const dataApp = initializeApp(firebaseConfig, 'db');

// App Check 클라 init은 넣지 않는다(2026-07-05 사용자 결정) — reCAPTCHA 스크립트 로드가
// 초기 반응속도를 깎는데 서버가 enforce off라 보안 이득이 없다. 도입 시 .memory/project_appcheck_rollout.md 참조.

export const auth = getAuth(app);

// dataApp의 Firestore가 인증 토큰을 받도록 [DEFAULT] auth를 미러링.
// 세션 저장은 [DEFAULT]가 담당하므로 여기는 in-memory.
const dataAuth = initializeAuth(dataApp, { persistence: inMemoryPersistence });
let _mirrorReady = Promise.resolve();
let _firstMirrorResolve;
const _firstMirror = new Promise((r) => { _firstMirrorResolve = r; });
onIdTokenChanged(auth, (user) => {
    _mirrorReady = dataAuth.updateCurrentUser(user)
        .catch(err => console.warn('[auth-mirror] dataApp 동기화 실패:', err))
        .finally(() => _firstMirrorResolve());
});
// Firestore 첫 쿼리 전에 미러링 완료를 보장 — onAuthStateChanged 콜백 첫 줄에서 await.
// 첫 미러 완료를 명시적으로 기다리므로 리스너 등록 순서에 의존하지 않는다.
export const dataAuthReady = () => _firstMirror.then(() => _mirrorReady);

let db;
try {
    db = initializeFirestore(dataApp, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
} catch {
    db = getFirestore(dataApp);
}
export { db };
