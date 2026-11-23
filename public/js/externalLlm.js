// public/js/externalLlm.js - 외부 LLM 사용 시 비식별 전송 확인과, 어려운 쟁점의 외부 재검토 제안
//
// 외부로 나가는 모든 경로는 같은 확인 창을 거친다. 사용자는 개인정보를 가린 전송 내용을 보고 승인하며,
// 승인은 그 내용의 해시에 묶여 서버가 검증한다. 내용이 달라지면 서버가 전송을 거절한다.
import { state, privateTermList } from './state.js';
import { renderWorkbench } from './lawWorkbench.js';

const PROVIDER_LABEL = { exaone: 'LG EXAONE', openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google Gemini' };
const LEGAL_LABEL = { APPLIES: '요건 충족', NOT_APPLICABLE: '요건 불충족', EXCEPTION_APPLIES: '예외 적용', CONDITIONAL: '판단 유보' };
const $ = id => document.getElementById(id);

const countsLabel = counts => Object.entries(counts || {}).map(([kind, n]) => `${kind} ${n}`).join(' · ') || '가린 항목 없음';
const label = provider => PROVIDER_LABEL[provider] || provider;

async function postJson(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  return data;
}

/**
 * 비식별된 전송 내용을 보여 주고 승인을 받는다.
 * @param {{ title: string, lead: string, load: (terms: string[]) => Promise<object> }} options load는 미리보기 응답을 돌려준다
 * @returns {Promise<{ digest: string, terms: string[] } | null>} 취소하면 null
 */
export function requestExternalApproval({ title, lead, load }) {
  const modal = $('external-confirm-modal');
  const termsBox = $('external-confirm-terms');
  const approve = $('btn-external-approve');
  termsBox.value = privateTermList().join('\n');
  $('external-confirm-title').textContent = title;
  $('external-confirm-lead').textContent = lead;
  let current = null;

  const termList = () => termsBox.value.split(/[\n,]/).map(x => x.trim()).filter(x => x.length >= 2);
  async function refresh() {
    approve.disabled = true;
    $('external-confirm-text').textContent = '비식별 내용을 만드는 중...';
    $('external-confirm-warning').classList.add('hidden');
    try {
      current = await load(termList());
      $('external-confirm-counts').textContent = `가린 항목: ${countsLabel(current.counts)} (${current.replacements ?? 0}건)`;
      $('external-confirm-text').textContent = current.text;
      const warning = $('external-confirm-warning');
      if (current.remaining?.length) {
        warning.textContent = `비식별 후에도 ${current.remaining.join(', ')}이(가) 남아 있습니다. 가릴 단어를 추가해 다시 비식별하십시오. 이 상태로는 전송할 수 없습니다.`;
        warning.classList.remove('hidden');
        approve.disabled = true;
      } else approve.disabled = false;
    } catch (err) {
      current = null;
      $('external-confirm-text').textContent = '';
      $('external-confirm-warning').textContent = `전송 내용을 만들지 못했습니다: ${err.message}`;
      $('external-confirm-warning').classList.remove('hidden');
    }
  }

  return new Promise(resolve => {
    const cleanup = result => {
      modal.classList.add('hidden');
      $('btn-external-approve').onclick = $('btn-external-cancel').onclick = $('btn-external-cancel-x').onclick = $('btn-external-refresh').onclick = null;
      resolve(result);
    };
    $('btn-external-refresh').onclick = refresh;
    $('btn-external-cancel').onclick = () => cleanup(null);
    $('btn-external-cancel-x').onclick = () => cleanup(null);
    approve.onclick = () => current && cleanup({ digest: current.digest, terms: termList() });
    modal.classList.remove('hidden');
    refresh();
  });
}

/** 외부 LLM만 쓰는 검토를 시작하기 전에, 질의·문서 전체의 비식별 전송 내용을 승인받는다. */
export function confirmReviewTransmission({ query, documentText = '', file = null, provider }) {
  return requestExternalApproval({
    title: `${label(provider)}로 보낼 내용 확인`,
    lead: `이 검토의 질의와 첨부문서 전체가 ${label(provider)} 서버로 전송됩니다. 아래는 개인정보를 가린 뒤의 내용입니다. 확인하고 승인해야 검토가 시작됩니다.`,
    load: async terms => {
      const body = new FormData();
      body.append('query', query);
      body.append('documentText', documentText);
      body.append('llmProvider', provider);
      body.append('privateTerms', JSON.stringify(terms));
      if (file) body.append('file', file);
      const res = await fetch('/api/law/privacy/preview', { method: 'POST', body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
      return { ...data, text: `[질의]\n${data.query || '(없음)'}\n\n[첨부문서]\n${data.documentText || '(없음)'}` };
    }
  });
}

/** 어려운 쟁점 카드. 한 장씩 승인하므로 어떤 쟁점이 어떤 이유로 나가는지 사용자가 안다. */
function escalationCard(candidate, data) {
  const issue = data.review?.reasoning?.issues?.find(i => i.id === candidate.issueId);
  const done = (data.review?.externalReviews || []).find(r => r.issueId === candidate.issueId);
  const card = document.createElement('div');
  card.className = 'escalation-card';
  const title = document.createElement('div');
  title.className = 'escalation-question';
  title.textContent = `쟁점 ${candidate.issueId.slice(1)} · ${candidate.question}`;
  const reasons = document.createElement('ul');
  reasons.className = 'escalation-reasons';
  for (const reason of candidate.reasons) { const li = document.createElement('li'); li.textContent = reason; reasons.append(li); }
  card.append(title, reasons);
  const action = document.createElement('div');
  action.className = 'escalation-action';
  if (done) {
    action.textContent = `${label(done.provider)} 답변 반영됨 · ${LEGAL_LABEL[done.before?.legal] || '판단 유보'} → ${LEGAL_LABEL[done.after?.legal] || '판단 유보'}`;
    action.classList.add('done');
  } else {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-secondary btn-sm';
    button.textContent = `${label(state.settings.externalProvider)}에 재검토 요청`;
    button.addEventListener('click', () => requestEscalation(candidate, data, button));
    action.append(button);
    if (issue?.conclusion) {
      const now = document.createElement('span');
      now.className = 'escalation-now';
      now.textContent = `현재 결론: ${LEGAL_LABEL[issue.conclusion.legal] || '판단 유보'}`;
      action.append(now);
    }
  }
  card.append(action);
  return card;
}

async function requestEscalation(candidate, data, button) {
  const provider = state.settings.externalProvider;
  const reviewId = data.review.escalation.reviewId;
  const approval = await requestExternalApproval({
    title: `쟁점 ${candidate.issueId.slice(1)} · ${label(provider)}로 보낼 내용 확인`,
    lead: `로컬 모델이 풀지 못한 이 쟁점의 사실·요건·근거 원문을 ${label(provider)} 서버로 보내 다시 판단받습니다. 개인정보를 가린 아래 내용이 전송되며, 받은 답변은 이 PC에서 원래 값으로 되돌립니다.`,
    load: terms => postJson('/api/law/escalation/preview', { reviewId, issueId: candidate.issueId, provider, privateTerms: terms })
  });
  if (!approval) return;
  button.disabled = true;
  button.textContent = `${label(provider)} 응답 대기 중...`;
  try {
    const result = await postJson('/api/law/escalation/send', { reviewId, issueId: candidate.issueId, provider, model: state.settings.externalModel,
      digest: approval.digest, privateTerms: approval.terms, historyId: data.historyId, localModel: state.settings.localModel });
    const review = data.review;
    const kept = { reviewStatus: review.reviewStatus, escalation: review.escalation };
    Object.assign(review, result.reviewPatch, kept);
    review.reasoning = { ...review.reasoning, ...result.reasoningPatch, gate: 'HUMAN_REVIEW_REQUIRED',
      gateReasons: [...new Set([...(review.reasoning?.gateReasons || []), result.externalNote])] };
    review.externalReviews = [...(review.externalReviews || []), { issueId: candidate.issueId, provider, model: state.settings.externalModel,
      at: new Date().toISOString(), before: result.before, after: result.after }];
    data.escalationLive = true;
    renderWorkbench(data);
  } catch (err) {
    alert(`외부 재검토를 완료하지 못했습니다: ${err.message}`);
    button.disabled = false;
    button.textContent = `${label(provider)}에 재검토 요청`;
  }
}

/** 병용 모드이고 방금 실행한 검토에 어려운 쟁점이 있으면 제안 패널을 보여 준다. */
export function renderEscalationPanel(data) {
  const panel = $('escalation-panel');
  if (!panel) return;
  const candidates = data?.review?.escalation?.candidates || [];
  const show = state.settings.mode === 'HYBRID' && data?.escalationLive && candidates.length;
  panel.classList.toggle('hidden', !show);
  panel.replaceChildren();
  if (!show) return;
  const head = document.createElement('div');
  head.className = 'escalation-head';
  const strong = document.createElement('strong');
  strong.textContent = `로컬 모델이 풀지 못한 쟁점 ${candidates.length}개`;
  const note = document.createElement('span');
  note.textContent = `${label(state.settings.externalProvider)}에 다시 물을 수 있습니다. 보내기 전에 개인정보를 가린 내용을 확인하고 승인합니다.`;
  head.append(strong, note);
  panel.append(head, ...candidates.map(candidate => escalationCard(candidate, data)));
}

document.addEventListener('workbench:rendered', event => renderEscalationPanel(event.detail));
