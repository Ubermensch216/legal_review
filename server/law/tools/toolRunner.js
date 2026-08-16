// server/law/tools/toolRunner.js - 19대 도구 통합 실행기
import { TOOL_DEFINITIONS } from './toolRegistry.js';
import { LawApiError, maskLawSecrets } from '../lawErrors.js';

// 도구 모듈 맵핑
import searchLaw from './searchLaw.js';
import searchAiLaw from './searchAiLaw.js';
import articleDetail from './articleDetail.js';
import articleAt from './articleAt.js';
import articleDiff from './articleDiff.js';
import lawHistory from './lawHistory.js';
import lawStructure from './lawStructure.js';
import delegatedLaws from './delegatedLaws.js';
import linkedOrdinances from './linkedOrdinances.js';
import annexes from './annexes.js';
import precedents from './precedents.js';
import interpretations from './interpretations.js';
import adminRules from './adminRules.js';
import decisions from './decisions.js';
import impactMap from './impactMap.js';
import timeTravel from './timeTravel.js';
import verifyCitations from './verifyCitations.js';

const toolHandlers = {
  searchLaw,
  searchAiLaw,
  articleDetail,
  articleAt,
  articleDiff,
  lawHistory,
  lawStructure,
  delegatedLaws,
  linkedOrdinances,
  annexes,
  precedents,
  interpretations,
  adminRules,
  decisions,
  impactMap,
  timeTravel,
  verifyCitations
};

/**
 * 특정 도구 실행
 * @param {string} toolName 
 * @param {object} params 
 * @returns {Promise<object>}
 */
export async function runTool(toolName, params = {}) {
  const handler = toolHandlers[toolName];
  if (!handler || typeof handler.execute !== 'function') {
    throw new LawApiError(`알 수 없는 도구 이름입니다: ${toolName}`, {
      statusCode: 400,
      code: 'UNKNOWN_TOOL'
    });
  }

  const startTime = Date.now();
  try {
    const result = await handler.execute(params);
    const durationMs = Date.now() - startTime;

    return {
      ok: true,
      tool: toolName,
      durationMs,
      result
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    return {
      ok: false,
      tool: toolName,
      durationMs,
      error: maskLawSecrets(err.message || '도구 실행 실패')
    };
  }
}

/**
 * 등록된 전체 도구 목록 반환
 */
export function getAvailableTools() {
  return TOOL_DEFINITIONS;
}

export default {
  runTool,
  getAvailableTools
};
