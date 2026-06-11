import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
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

// 통합 호스팅(같은 origin)에서 앱별 Firestore persistence를 분리하기 위한 고유 앱 이름.
// [DEFAULT] 공유 시 다른 impact7 앱 탭과 primary lease 충돌로 write가 hang됨.
const app = initializeApp(firebaseConfig, 'db');

export const auth = getAuth(app);

let db;
try {
    db = initializeFirestore(app, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
} catch {
    db = getFirestore(app);
}
export { db };
