import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runAuthenticatedStartup } from '../startup.js';

test('인증 후 독립 설정을 병렬 로드하고 학생 목록을 순서대로 연다', async () => {
    const events = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const dependency = (name) => async () => {
        events.push(`${name}:start`);
        await gate;
        events.push(`${name}:end`);
    };

    const startup = runAuthenticatedStartup({
        loadUserRole: dependency('role'),
        loadPopulationPerms: dependency('perms'),
        loadSemesterSettings: dependency('semester'),
        getCurrentSemester: () => events.push('current-semester'),
        loadStudentList: async () => events.push('students'),
        generateDailyStatsIfNeeded: async () => events.push('stats'),
        onError: () => events.push('error'),
    });

    await Promise.resolve();
    assert.deepEqual(events, ['role:start', 'perms:start', 'semester:start']);
    release();
    assert.equal(await startup, true);
    assert.deepEqual(events.slice(-3), ['current-semester', 'students', 'stats']);
});

test('필수 설정 실패 시 학생 목록을 열지 않고 오류 경계로 보낸다', async () => {
    const failure = new Error('semester unavailable');
    let received;
    let studentsLoaded = false;
    const result = await runAuthenticatedStartup({
        loadUserRole: async () => {},
        loadPopulationPerms: async () => {},
        loadSemesterSettings: async () => { throw failure; },
        getCurrentSemester: () => {},
        loadStudentList: async () => { studentsLoaded = true; },
        generateDailyStatsIfNeeded: async () => {},
        onError: (error) => { received = error; },
    });

    assert.equal(result, false);
    assert.equal(received, failure);
    assert.equal(studentsLoaded, false);
});

test('초기 HTML은 bootstrap만 로드하고 외부 Google SDK를 eager load하지 않는다', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const bootstrap = await readFile(new URL('../bootstrap.js', import.meta.url), 'utf8');
    const firebaseConfig = JSON.parse(await readFile(new URL('../firebase.json', import.meta.url), 'utf8'));
    const redirectPage = await readFile(new URL('../_redirect/index.html', import.meta.url), 'utf8');

    assert.match(html, /type="module" src="\/bootstrap\.js"/);
    assert.match(html, /href="%BASE_URL%favicon\.svg"/);
    assert.match(html, /src="%BASE_URL%impact7-logo\.webp"/);
    assert.match(html, /src="%BASE_URL%help-guide\.js"/);
    assert.match(html, /<button type="button" class="avatar icon-btn"[^>]*disabled>/);
    assert.doesNotMatch(html, /type="module" src="app\.js"/);
    assert.doesNotMatch(html, /type="module" src="promo-extractor\.js"/);
    assert.doesNotMatch(html, /apis\.google\.com\/js\/api\.js|accounts\.google\.com\/gsi\/client/);
    assert.doesNotMatch(bootstrap, /^import /m);
    assert.equal(firebaseConfig.hosting.redirects[0].destination, 'https://impact7-app.web.app/db/');
    assert.match(redirectPage, /https:\/\/impact7-app\.web\.app\/db\//);
});
