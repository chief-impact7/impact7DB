import { defineSecret } from 'firebase-functions/params';

// 솔라피 자격증명 Secret 정의만 모은 경량 모듈. index.js와 solapiProvider.js가 공유한다.
// solapi SDK를 import하지 않으므로, index.js가 이 파일만 정적 import하면
// attendanceCheckin/getMessageDeliveryStatus 콜드스타트에 solapi 패키지가 로드되지 않는다.
export const SOLAPI_API_KEY = defineSecret('SOLAPI_API_KEY');
export const SOLAPI_API_SECRET = defineSecret('SOLAPI_API_SECRET');
