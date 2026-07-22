const scriptLoads = new Map();
let pickerLoad;

function loadScript(src) {
    if (!scriptLoads.has(src)) {
        const load = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = resolve;
            script.onerror = () => {
                scriptLoads.delete(src);
                script.remove();
                reject(new Error(`스크립트 로드 실패: ${src}`));
            };
            document.head.appendChild(script);
        });
        scriptLoads.set(src, load);
    }
    return scriptLoads.get(src);
}

export async function loadGoogleIdentityServices() {
    if (globalThis.google?.accounts?.oauth2) return;
    await loadScript('https://accounts.google.com/gsi/client');
}

export async function loadGooglePickerApi() {
    if (globalThis.google?.picker) return;
    if (!pickerLoad) {
        pickerLoad = (async () => {
            await loadScript('https://apis.google.com/js/api.js');
            await new Promise((resolve, reject) => {
                globalThis.gapi.load('picker', {
                    callback: resolve,
                    onerror: () => reject(new Error('Google Picker API 초기화 실패')),
                });
            });
        })().catch((error) => {
            pickerLoad = undefined;
            throw error;
        });
    }
    await pickerLoad;
}
