import { HttpsError } from 'firebase-functions/v2/https';

const MAX_MMS_IMAGE_BYTES = 200 * 1024;

async function defaultUploadMmsImage(image) {
  const provider = await import('./solapiProvider.js');
  return provider.uploadMmsImage(image, provider.getSolapiConfig());
}

export function parseMmsImage(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object') throw new HttpsError('invalid-argument', 'MMS 이미지 형식이 올바르지 않습니다.');

  const name = String(raw.name ?? 'mms.jpg').trim();
  if (!/\.jpe?g$/i.test(name)) throw new HttpsError('invalid-argument', 'MMS 이미지는 JPG 파일만 사용할 수 있습니다.');

  const dataBase64 = String(raw.dataBase64 ?? '')
    .replace(/^data:image\/jpeg;base64,/i, '')
    .replace(/\s/g, '');
  const maxBase64Length = Math.ceil(MAX_MMS_IMAGE_BYTES / 3) * 4;
  if (!dataBase64 || dataBase64.length > maxBase64Length || dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) {
    throw new HttpsError('invalid-argument', 'MMS 이미지 데이터가 올바르지 않습니다.');
  }

  const bytes = Buffer.from(dataBase64, 'base64');
  if (!bytes.length || bytes.length > MAX_MMS_IMAGE_BYTES) {
    throw new HttpsError('invalid-argument', 'MMS 이미지는 200KB 이하만 사용할 수 있습니다.');
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new HttpsError('invalid-argument', '실제 JPG 이미지 파일만 사용할 수 있습니다.');
  }
  return { name: name.slice(0, 120), dataBase64 };
}

export async function resolveMmsImageId(raw, uploadMmsImage = defaultUploadMmsImage) {
  const image = parseMmsImage(raw);
  if (!image) return null;
  try {
    const imageId = await uploadMmsImage(image);
    if (imageId) return imageId;
  } catch (error) {
    console.error('[MMS] 이미지 업로드 실패:', error?.message ?? error);
  }
  throw new HttpsError('internal', 'MMS 이미지 업로드에 실패했습니다. 잠시 후 다시 시도해주세요.');
}
