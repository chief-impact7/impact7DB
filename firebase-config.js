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

// App Check(reCAPTCHA Enterprise) — DSC/HR과 동일 키·패턴. 서버 callable이 enforce off라
// 지금은 토큰 발급·검증률 축적 단계이며, 실패해도 기능 영향 없음(soft-fail).
// enforce 전환 전 reCAPTCHA 키에 이 앱 도메인(impact7db.web.app, db.impact7.kr) 등록 필수.
(async () => {
    try {
        if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
            self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
        }
        const { initializeAppCheck, ReCaptchaEnterpriseProvider } = await import('firebase/app-check');
        initializeAppCheck(dataApp, {
            provider: new ReCaptchaEnterpriseProvider('6LcS4ywtAAAAADd8BBiFo_Fd4XXiXT1Uf3gHGxYl'),
            isTokenAutoRefreshEnabled: true,
        });
    } catch (err) {
        console.warn('[app-check] 초기화 실패(무강제 단계 — 기능 영향 없음):', err);
    }
})();

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
