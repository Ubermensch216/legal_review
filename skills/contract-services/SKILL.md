---
id: contract-services
name: 용역·도급 계약 리스크
kind: domain
version: 1.0.0
origin: migrated
presets: [contract_risk]
documentTypes: [CONTRACT]
keywords: [계약서, 용역, 도급, 지체상금, 위약벌, 해지, 지식재산]
stages: [collect]
lawSnapshot: 2026-11-28
expertReviewed: null
status: active
---

## S1 지침
계약 문언으로 확인되는 부담과 실제 효력 판단을 분리한다. 과업변경·위약·해지·책임·지식재산·인력지휘·분쟁절차·대금지급 및 필요한 조항의 부재를 살핀다. 약관성·기관 유형 등 미확정 전제를 단정하지 않는다.

## 작성 메모
server/reasoning/contractReview.js(RULES·CLAUSE_CHECKS·TOPIC_MENTION·ISSUE_TERMS·AUTHORITY_HINTS·조문 씨앗)와 server/reasoning/verifiedRules.js(ARTICLE_EXPECTATIONS)에 코드로 있던 계약 규칙을 동작 그대로 contract.json으로 옮겼다(origin: migrated).
계약 검토 경로(contract_risk)는 이 데이터를 스킬 적용 방식과 무관하게 항상 쓴다. 그래서 선택기(skillRouter)의 적용 대상이 아니고, S1 지침은 prompts.js의 기존 문구와 같다.
규칙을 고치면 version을 올리고 test/contractReview.test.js를 통과시켜야 한다.
