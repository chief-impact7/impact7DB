import { defineConfig } from 'vite'

export default defineConfig({
    root: './', // 현재 폴더를 루트로 명시
    server: {
        host: true, // 로컬 네트워크 접속 허용
        port: 5173
    }
})