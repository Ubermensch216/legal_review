// server/law/progressReporter.js - 검토 파이프라인 진행 상황 리포터
//
// 검토는 법령 수집 → 판례/해석례 조회 → 재순위 → 프롬프트 예산 → LLM 생성 → 인용 검증까지
// 수 분이 걸린다. 그 사이 화면에 스피너만 돌면 사용자는 무엇이 진행 중인지 알 수 없다.
// 파이프라인 각 단계가 이 리포터로 자기 진행을 알리고, 라우터가 그것을 NDJSON으로 흘려보낸다.
//
// 설계 원칙:
//  - 계측은 검토 결과에 영향을 주지 않는다. emit이 없으면 모든 메서드는 무동작이다.
//  - 리포터에서 난 예외가 검토를 중단시키지 않는다. (계측 실패보다 검토 완료가 중요하다)
//  - 단계 키는 화면의 타임라인 항목 하나에 대응한다. 같은 키로 start → done을 호출한다.

/**
 * @typedef {object} ProgressEvent
 * @property {number} seq       발행 순번 (프론트에서 순서 보장에 사용)
 * @property {number} at        검토 시작 후 경과 ms
 * @property {string} kind      'step' | 'tick' | 'note' | 'warn' | 'finish'
 * @property {string} key       단계 식별자
 * @property {string} [label]   단계 표시명
 * @property {string} [state]   'RUNNING' | 'DONE' | 'SKIPPED' | 'FAILED'
 * @property {string} [detail]  단계 진행/결과 요약 한 줄
 * @property {string} [group]   '준비' | '수집' | '분석' | '작성' | '검증'
 * @property {number} [ms]      해당 단계 소요 시간
 * @property {object} [meta]    화면 진행률 계산에 쓰는 구조화된 작업량 정보
 */

/**
 * 진행 리포터를 만든다.
 * @param {((event: ProgressEvent) => void)|null} emit 이벤트 수신자. 없으면 무동작 리포터.
 * @returns {ProgressReporter}
 */
export function createProgressReporter(emit) {
  const enabled = typeof emit === 'function';
  const startedAt = Date.now();
  const open = new Map();
  let seq = 0;
  let lastTickAt = 0;

  const send = (event) => {
    if (!enabled) return;
    try {
      emit({ seq: ++seq, at: Date.now() - startedAt, ...event });
    } catch {
      // 계측 실패는 검토를 막지 않는다.
    }
  };

  return {
    enabled,

    /** 단계 시작을 알린다. */
    start(key, label, detail = '', group = '') {
      open.set(key, { at: Date.now(), label, group });
      send({ kind: 'step', state: 'RUNNING', key, label, detail, group });
    },

    /** 단계 완료. detail에는 "무엇을 얼마나 얻었는지"를 한 줄로 적는다. */
    done(key, detail = '', state = 'DONE', meta = undefined) {
      const entry = open.get(key);
      open.delete(key);
      send({
        kind: 'step', state, key,
        label: entry?.label, group: entry?.group,
        detail, ms: entry ? Date.now() - entry.at : undefined, meta
      });
    },

    /** 시작 없이 끝난 단계를 한 번에 기록한다. (동기 집계처럼 즉시 끝나는 단계) */
    mark(key, label, detail = '', group = '', state = 'DONE', meta = undefined) {
      send({ kind: 'step', state, key, label, detail, group, ms: 0, meta });
    },

    /** 단계를 건너뛴 사실을 남긴다. (해당 없음 / 조회 대상 없음) */
    skip(key, label, detail = '', group = '') {
      send({ kind: 'step', state: 'SKIPPED', key, label, detail, group, ms: 0 });
    },

    /** 단계 실패. 검토 자체는 폴백으로 계속될 수 있으므로 여기서 던지지 않는다. */
    fail(key, detail = '') {
      this.done(key, detail, 'FAILED');
    },

    /** 진행 중인 단계에 붙는 보조 줄. (후보 법령 채택 실패, 개별 조회 결과 등) */
    note(key, detail) {
      send({ kind: 'note', key, detail });
    },

    /** 제한 사항 경고. 화면에서는 노란 줄로 표시한다. */
    warn(key, detail) {
      send({ kind: 'warn', key, detail });
    },

    /**
     * 진행 중인 단계의 실시간 수치 갱신(LLM 생성 글자 수 등).
     * 초당 수십 회 들어올 수 있어 기본 400ms로 솎아낸다.
     */
    tick(key, detail, minIntervalMs = 400) {
      if (!enabled) return;
      const now = Date.now();
      if (now - lastTickAt < minIntervalMs) return;
      lastTickAt = now;
      send({ kind: 'tick', key, detail });
    },

    /** 파이프라인 종료 요약. */
    finish(detail = '') {
      send({ kind: 'finish', key: '__finish__', detail, ms: Date.now() - startedAt });
    },

    elapsedMs() {
      return Date.now() - startedAt;
    }
  };
}

/** 계측 지점에서 분기하지 않도록, emit 없는 기본 리포터를 제공한다. */
export const NOOP_PROGRESS = createProgressReporter(null);

/** 숫자를 "3건" 형태로. 0도 사실이므로 숨기지 않는다. */
export const countLabel = (n, unit = '건') => `${Number(n) || 0}${unit}`;

export default { createProgressReporter, NOOP_PROGRESS, countLabel };
