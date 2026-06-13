import { GoogleGenAI } from '@google/genai';

const PROJECT = 'impact7db';
const LOCATION = 'global';

let _client;
function client() {
  if (!_client) {
    _client = new GoogleGenAI({ vertexai: true, project: PROJECT, location: LOCATION });
  }
  return _client;
}

// 기존 호출처(llmHandler, studentReportAiHandler) 호환: 텍스트만 반환.
export async function generateText(model, prompt, config = {}) {
  const resp = await client().models.generateContent({ model, contents: prompt, config });
  return resp.text ?? '';
}

// 토큰 집계가 필요한 호출(일괄 비용 추적)용 opt-in 변형. generateText 반환 타입은 건드리지 않는다.
// usage는 usageMetadata(promptTokenCount/candidatesTokenCount/totalTokenCount)를 0 기본값으로 정규화.
export async function generateTextWithUsage(model, prompt, config = {}) {
  const resp = await client().models.generateContent({ model, contents: prompt, config });
  const u = resp.usageMetadata || {};
  return {
    text: resp.text ?? '',
    usage: {
      promptTokenCount: Number(u.promptTokenCount || 0),
      candidatesTokenCount: Number(u.candidatesTokenCount || 0),
      totalTokenCount: Number(u.totalTokenCount || 0),
    },
  };
}
