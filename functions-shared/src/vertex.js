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

export async function generateText(model, prompt, config = {}) {
  const resp = await client().models.generateContent({
    model,
    contents: prompt,
    config,
  });
  return resp.text ?? '';
}
