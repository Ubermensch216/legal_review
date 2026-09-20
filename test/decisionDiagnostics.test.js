import './setup.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ENV } from '../server/env.js';
import { clearAllCache } from '../server/law/lawCache.js';
import { searchPrecedents, searchInterpretations } from '../server/law/decisionsApiClient.js';
import { parseInterpretations } from '../server/law/decisionsApiParser.js';
import { summarizeAvailability } from '../server/law/decisionDiagnostics.js';

const noNetwork = globalThis.fetch;
afterEach(async () => { globalThis.fetch = noNetwork; ENV.LAW_OC = ''; await clearAllCache(); });
const response = text => ({ ok: true, text: async () => text });
const list = '<PrecSearch><prec><판례일련번호>10</판례일련번호><사건번호>2020다1</사건번호></prec></PrecSearch>';

test('실제 Expc 목록 계약의 회신 기관·일자를 보존한다', () => {
  const items = parseInterpretations('<Expc><resultCode>00</resultCode><expc><법령해석례일련번호>1</법령해석례일련번호><안건명>픽스처</안건명><회신기관명>법제처</회신기관명><회신일자>2020.11.05</회신일자></expc></Expc>');
  assert.equal(items[0].orgName, '법제처');
  assert.equal(items[0].replyDate, '2020.11.05');
  assert.throws(() => parseInterpretations('<Expc><resultCode>99</resultCode><resultMsg>실패</resultMsg></Expc>'), { code: 'API_RESULT_ERROR' });
});

test('본문 실패를 네트워크·시간 초과·HTTP·계약·식별자 오류로 구분한다', async () => {
  ENV.LAW_OC = 'fixture';
  const cases = [
    ['NETWORK_ERROR', async () => { throw new Error('secret request URL'); }],
    ['TIMEOUT', async () => { throw Object.assign(new Error('abort'), { name: 'TimeoutError' }); }],
    ['HTTP_403', async () => ({ ok: false, status: 403 })],
    ['UNEXPECTED_BODY_ROOT', async () => response('<Law><message>조회 불가</message></Law>')],
    ['INVALID_XML', async () => response('<PrecService>')],
    ['MISSING_BODY_FIELDS', async () => response('<PrecService><판례정보일련번호>10</판례정보일련번호></PrecService>')],
    ['RECORD_ID_MISMATCH', async () => response('<PrecService><판례정보일련번호>11</판례정보일련번호><사건번호>2020다1</사건번호><판결요지>요지</판결요지></PrecService>')]
  ];
  for (const [code, detail] of cases) {
    await clearAllCache();
    globalThis.fetch = async url => String(url).includes('lawSearch.do') ? response(list) : detail();
    const items = await searchPrecedents('진단', 1, 1);
    assert.equal(items[0].detailErrorCode, code);
    assert.equal(items[0].contentStatus, 'LIST_ONLY');
    assert.doesNotMatch(items[0].detailError, /secret/);
    const stats = summarizeAvailability(items);
    assert.equal(stats.fullTextCount, 0);
    assert.equal(stats.failures[code], 1);
    assert.equal(stats.status, 'PARTIAL');
  }
});

test('본문 확보 통계는 미설정·빈 목록·혼합 결과를 구분하고 JSON에서 유지된다', async () => {
  const unavailable = await searchInterpretations('개인정보');
  assert.equal(summarizeAvailability(unavailable).status, 'UNAVAILABLE');
  assert.equal(summarizeAvailability([]).status, 'EMPTY');
  const mixed = summarizeAvailability([
    { source: 'OFFICIAL_API', contentStatus: 'FULL_TEXT' },
    { source: 'OFFICIAL_API', contentStatus: 'LIST_ONLY', detailErrorCode: 'HTTP_403' },
    { source: 'OFFICIAL_API', contentStatus: 'FULL_TEXT', isMockData: true }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(mixed)), {
    listCount: 3, fullTextCount: 1, unavailableCount: 2, status: 'PARTIAL', failures: { HTTP_403: 1, DEMO_DATA: 1 }
  });
});
