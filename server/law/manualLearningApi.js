import express from 'express';
import { createManualLearningService } from './manualLearning.js';

export function createManualLearningRouter(dependencies) {
  const router = express.Router();
  let service;
  const run = fn => async (req, res) => {
    try {
      service ||= createManualLearningService(dependencies);
      await fn(service, req, res);
    } catch (error) {
      const status = error.statusCode || 500;
      // Never return raw model output, source material or storage exceptions.
      res.status(status).json({ ok: false, error: error.statusCode ? error.message : '학습 자료를 처리하지 못했습니다. 입력 형식과 로컬 저장소를 확인하십시오.' });
    }
  };
  router.get('/', run((s, req, res) => res.json({ ok: true, ...s.list() })));
  router.post('/inquiries', run(async (s, req, res) => res.json({ ok: true, ...await s.createInquiry(req.body) })));
  router.patch('/inquiries/:id', run((s, req, res) => res.json({ ok: true, item: s.editInquiry(req.params.id, req.body) })));
  router.post('/inquiries/:id/confirm', run((s, req, res) => res.json({ ok: true, item: s.confirmInquiry(req.params.id, req.body) })));
  router.get('/inquiries/:id/export', run((s, req, res) => {
    const text = s.exportInquiry(req.params.id);
    res.set('Cache-Control', 'no-store').type('text/plain').send(text);
  }));
  router.post('/inquiries/:id/answers', run(async (s, req, res) => res.json({ ok: true, item: await s.importAnswer(req.params.id, req.body) })));
  router.patch('/knowledge/:id', run((s, req, res) => res.json({ ok: true, item: s.editKnowledge(req.params.id, req.body) })));
  router.post('/knowledge/:id/approve', run((s, req, res) => res.json({ ok: true, item: s.approveKnowledge(req.params.id, req.body) })));
  router.post('/knowledge/:id/revoke', run((s, req, res) => res.json({ ok: true, item: s.revokeKnowledge(req.params.id, req.body) })));
  router.delete('/:id', run((s, req, res) => { s.delete(req.params.id); res.json({ ok: true }); }));
  return router;
}
