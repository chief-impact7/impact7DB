/**
 * sheet-export.js — Google Sheets API 호출 헬퍼
 *
 * 사용 예:
 *   await createGoogleSheet('내보내기_2026-05-18',
 *     ['이름', '학년', '전화'],
 *     [['김지유', '초3', '010-1'], ['이서연', '초4', '010-2']]);
 *
 * OAuth 토큰은 auth.js의 getGoogleAccessToken에서 가져온다.
 * 토큰 없으면 alert 후 null 반환.
 */
import { ensureGoogleAccessToken } from './auth.js';

export async function createGoogleSheet(title, headers, rows) {
    const token = await ensureGoogleAccessToken();
    if (!token) {
        alert('구글 드라이브 접근 권한이 필요합니다.\n로그아웃 후 다시 로그인해주세요.');
        return null;
    }

    const headerRow = {
        values: headers.map(h => ({
            userEnteredValue: { stringValue: h },
            userEnteredFormat: {
                textFormat: { bold: true, foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } } },
                backgroundColorStyle: { rgbColor: { red: 0.263, green: 0.522, blue: 0.957 } }
            }
        }))
    };
    const bodyRows = rows.map(row => ({
        values: row.map(cell => ({ userEnteredValue: { stringValue: String(cell ?? '') } }))
    }));

    try {
        const createResp = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                properties: { title },
                sheets: [{
                    properties: { title: '데이터', gridProperties: { frozenRowCount: 1 } },
                    data: [{ startRow: 0, startColumn: 0, rowData: [headerRow, ...bodyRows] }]
                }]
            })
        });
        if (!createResp.ok) throw new Error(await createResp.text());
        const created = await createResp.json();
        const sid = created.sheets[0].properties.sheetId;

        const totalRows = rows.length + 1;
        const fmtResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${created.spreadsheetId}:batchUpdate`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests: [
                { setBasicFilter: { filter: { range: { sheetId: sid, startRowIndex: 0, endRowIndex: totalRows, startColumnIndex: 0, endColumnIndex: headers.length } } } },
                { autoResizeDimensions: { dimensions: { sheetId: sid, dimension: 'COLUMNS', startIndex: 0, endIndex: headers.length } } }
            ]})
        });
        if (!fmtResp.ok) console.warn('[sheet-export] 서식 설정 실패:', await fmtResp.text());

        window.open(created.spreadsheetUrl, '_blank');
        return created.spreadsheetUrl;
    } catch (e) {
        alert('시트 내보내기 실패: ' + e.message + '\n\n로그아웃 후 다시 로그인하면 해결될 수 있습니다.');
        return null;
    }
}
