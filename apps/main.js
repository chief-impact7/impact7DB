import { loginWithGoogle, getCurrentUser } from "../core/auth.js";
import { secureWrite } from "../core/userlog.js";

const form = document.getElementById('registrationForm');

// 1. 페이지 로드 시 로그인 체크
getCurrentUser((user) => {
    if (!user) {
        alert("로그인이 필요합니다.");
        loginWithGoogle(); // 로그인이 안 되어 있으면 구글 로그인 창 띄움
    }
});

// 2. 폼 제출 이벤트
form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const studentData = {
        name: document.getElementById('name').value,
        school: document.getElementById('school').value,
        grade: document.getElementById('grade').value,
        parent_phone1: document.getElementById('parent_phone1').value,
        status: document.getElementById('status').value,
        created_at: new Date().toISOString()
    };

    try {
        // core/userlog.js의 secureWrite 사용 (로그 자동 생성)
        const docId = await secureWrite("students", studentData);
        alert(`성공적으로 등록되었습니다! (ID: ${docId})`);
        form.reset(); // 입력창 초기화
    } catch (error) {
        console.error("저장 실패:", error);
        alert("저장 중 오류가 발생했습니다.");
    }
});