// S6 원장에서 실제 뒷받침된 명제만 사용자 보고서의 근거로 승격한다.
import { provenanceOnly } from './stages/elements.js';
const ROLE = Object.freeze({ ARTICLE: 'DIRECT_RULE', ORDINANCE_ARTICLE: 'DIRECT_RULE',
  PRECEDENT: 'INTERPRETIVE_PRECEDENT', INTERPRETATION: 'INTERPRETIVE_PRECEDENT' });
const ARTICLE_EXPECTATIONS = [
  { test: /위임.{0,25}(언제든지|해지|불리한 시기)|불리한 시기.{0,25}위임|부득이한 사유.{0,40}불리한 시기/, law: '민법', article: '689' },
  { test: /도급.{0,35}(완성.{0,12}전|완성하기 전|해제)|완성.{0,12}전.{0,25}도급/, law: '민법', article: '673' },
  { test: /선량한 풍속|사회질서에 반|반사회질서/, law: '민법', article: '103' },
  { test: /합의관할|전속관할 합의/, law: '민사소송법', article: '29' },
  { test: /저작재산권.{0,35}양도|2차적저작물.{0,35}(권리|추정)/, law: '저작권법', article: '45' },
  { test: /저작인격권.{0,35}(양도|일신전속|행사|저작자)/, law: '저작권법', article: '14' }
];

export function exactAuthorityMatch(text, entry) {
  const expected = ARTICLE_EXPECTATIONS.find(item => item.test.test(String(text || '')));
  if (!expected) return true;
  return entry?.lawName === expected.law && String(entry.articleNo || '') === expected.article;
}

const root = (entry, registry) => entry?.parentId ? registry.get(entry.parentId) || entry : entry;
const category = entry => /^(ARTICLE|ORDINANCE_ARTICLE)/.test(entry?.kind || '') ? 'statutes'
  : /PRECEDENT/.test(entry?.kind || '') ? 'precedents' : 'interpretations';
const LIMIT = { statutes: 3, precedents: 2, interpretations: 2 };

export function attachVerifiedRules(issueResults, ledger, registry, facts = []) {
  const factById = new Map(facts.map(f => [f.id, f]));
  for (const result of issueResults) {
    const propositions = [];
    const selected = { statutes: [], precedents: [], interpretations: [] };
    for (const element of result.elements || []) {
      if (provenanceOnly(element.text)) continue;
      const assessment = (result.assessments || []).find(a => a.elementId === element.id);
      const claim = ledger.find(w => w.issueId === result.issueId && w.elementId === element.id);
      const text = String(element.text || '').trim();
      const decisive = (result.conclusion?.decidingElementIds || []).includes(element.id);
      const verifiedChecks = (claim?.checks || []).filter(check => check.entailment === 'SUPPORTS'
        || (!decisive && check.entailment === 'PARTIAL'))
        .filter(check => {
          const entry = registry.get(check.evidenceId);
          return entry?.official && entry?.inForce && String(entry.text || '').trim()
            && exactAuthorityMatch(text, root(entry, registry));
        });
      // 기본분석이 대조하지 않은 주장: 공식 출처·시행 여부만 확인된 근거로 따로 표시한다. '검증됨'으로 올리지 않는다.
      const sourceOnly = !verifiedChecks.length && claim?.overall === 'NOT_CHECKED'
        ? (claim.checks || []).filter(check => check.skippedByDepth && String(registry.get(check.evidenceId)?.text || '').trim()
          && exactAuthorityMatch(text, root(registry.get(check.evidenceId), registry))) : [];
      const verified = verifiedChecks.length > 0;
      const authorityIds = [...new Set((verified ? verifiedChecks : sourceOnly).map(c => c.evidenceId))].slice(0, 3);
      const first = registry.get(authorityIds[0]);
      const proposition = { id: `RP-${result.issueId}-${String(propositions.length + 1).padStart(2, '0')}`,
        issueId: result.issueId, text, authorityIds,
        authorityRole: element.isException ? 'EXCEPTION' : ROLE[root(first, registry)?.kind] || 'DIRECT_RULE',
        verified, relevance: decisive ? 'DECISIVE' : 'SUPPORTING',
        verificationStatus: verified ? 'VERIFIED' : sourceOnly.length ? 'SOURCE_ONLY' : 'UNVERIFIED',
        verificationMessage: verified ? '' : sourceOnly.length ? '공식 출처와 시행 여부만 확인했고, 내용 대응은 심화분석에서 확인합니다'
          : '해당 명제와 연결되는 공식 원문 근거를 확인하지 못함' };
      propositions.push(proposition);
      element.rulePropositionIds = [proposition.id];
      element.relevance = decisive ? 'DECISIVE' : element.relevance || 'SUPPORTING';
      const linkedFacts = (assessment?.factIds || []).map(id => factById.get(id)).filter(Boolean);
      element.factRequirement ||= linkedFacts.some(f => f.sourceType === 'DOCUMENT') ? 'DOCUMENT'
        : linkedFacts.length ? 'EXTERNAL' : 'UNKNOWN';
      if (assessment) {
        assessment.authorityEvidenceIds = authorityIds;
        assessment.ruleStatus = proposition.verificationStatus;
        assessment.factStatus = linkedFacts.some(f => f.sourceType === 'DOCUMENT' && f.quoteVerified) ? 'DOCUMENT_CONFIRMED'
          : linkedFacts.some(f => f.status === 'CONFIRMED') ? 'EXTERNALLY_CONFIRMED'
            : linkedFacts.some(f => f.status === 'DISPUTED') ? 'DISPUTED' : 'UNKNOWN';
        assessment.applicationStatus = assessment.status === 'UNKNOWN' ? 'DEPENDS_ON_FACTS'
          : assessment.status === 'PARTIALLY_SATISFIED' ? 'PARTIAL' : assessment.status;
      }
      for (const id of verified ? authorityIds : []) {
        const entry = registry.get(id);
        const group = category(entry);
        if (!selected[group].includes(id) && selected[group].length < LIMIT[group]) selected[group].push(id);
      }
    }
    result.rulePropositions = propositions;
    result.appliedAuthorities = Object.values(selected).flat();
    if (result.counter?.basisType === 'AUTHORITY') {
      const basisIds = (result.counter.basisIds || []).filter(id => result.appliedAuthorities.includes(id));
      result.counter = basisIds.length ? { ...result.counter, basisIds } : null;
    }
  }
  return issueResults;
}
