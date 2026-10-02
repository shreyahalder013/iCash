const service = require('../services/subscriptionService');

async function detect(req, res, next) {
  try {
    res.json({ ok: true, subscriptions: await service.detectSubscriptions(req.user.id) });
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    res.json({ ok: true, subscriptions: await service.listSubscriptions(req.user.id) });
  } catch (err) {
    next(err);
  }
}

module.exports = { detect, list };
