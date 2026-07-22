let appPromise;
let authModules;
let authPromise;
let iconPromise;
let promoPromise;
let toastPromise;

function loadApp() {
    appPromise ||= import('./app.js');
    return appPromise;
}

function loadAuth() {
    authPromise ||= Promise.all([
        import('firebase/auth'),
        import('./firebase-config.js'),
        import('./auth.js'),
    ]).then(([{ onAuthStateChanged }, { auth }, { signInWithGoogle, logout }]) => {
        authModules = { auth, logout, onAuthStateChanged, signInWithGoogle };
        return authModules;
    });
    return authPromise;
}

window.loadIconRenderer = () => {
    iconPromise ||= import('./ms-icon.js').then(({ msIcon }) => {
        window.msIcon = msIcon;
    });
    return iconPromise;
};

function showToast(...args) {
    toastPromise ||= import('./toast.js');
    toastPromise.then((toast) => toast.showToast(...args)).catch((error) => {
        console.error('[BOOTSTRAP] 알림 모듈 로드 실패:', error);
    });
}

const loadThemeAndToggle = async () => {
    await import('./theme.js');
    window.toggleTheme();
};
window.toggleTheme = loadThemeAndToggle;

window.handleLogin = async () => {
    if (!authModules) return;
    try {
        const { auth, signInWithGoogle, logout } = authModules;
        if (auth.currentUser) await logout();
        else await signInWithGoogle();
    } catch (error) {
        const messages = {
            'auth/api-key-not-valid': 'API 키 오류 — Firebase Console에서 API 키를 확인하세요',
            'auth/unauthorized-domain': '인증되지 않은 도메인 — Firebase Auth 승인 도메인을 확인하세요',
            'auth/popup-blocked': '팝업이 차단됐습니다. 브라우저에서 팝업을 허용해주세요.',
            'auth/popup-closed-by-user': '팝업이 닫혔습니다. 다시 시도하세요.',
            'auth/cancelled-popup-request': '이미 로그인 팝업이 열려 있습니다.',
        };
        showToast(messages[error.code] || `로그인 실패: ${error.code || error.message}`, 'error');
    }
};

window.loadPromoExtractView = async () => {
    const { auth } = await loadAuth();
    if (!auth.currentUser) return;
    await loadApp();
    promoPromise ||= import('./promo-extractor.js');
    await promoPromise;
    window.openPromoExtractView();
};

async function initializeAuth() {
    try {
        const { auth, onAuthStateChanged } = await loadAuth();
        onAuthStateChanged(auth, (user) => {
            if (!user) return;

            const list = document.querySelector('.list-items');
            if (list) list.innerHTML = '<div class="skeleton-item"></div>'.repeat(8);
            loadApp().catch((error) => {
                console.error('[BOOTSTRAP] 앱 로드 실패:', error);
                if (list) list.innerHTML = '<p style="padding:16px;color:var(--danger)">앱을 불러오지 못했습니다. 새로고침해주세요.</p>';
                showToast('앱을 불러오지 못했습니다. 새로고침해주세요.', 'error', { sticky: true });
            });
        });
        const loginButton = document.getElementById('login-avatar-btn');
        loginButton?.removeAttribute('disabled');
    } catch (error) {
        console.error('[BOOTSTRAP] 인증 모듈 로드 실패:', error);
        showToast('로그인 기능을 불러오지 못했습니다. 새로고침해주세요.', 'error', { sticky: true });
    }
}

initializeAuth();
