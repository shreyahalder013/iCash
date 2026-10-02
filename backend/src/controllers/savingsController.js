const service = require('../services/savingsService');

exports.list = async (req, res, next) => {
  try {
    res.json({ ok: true, challenges: await service.listChallenges(req.user.id) });
  } catch (err) {
    next(err);
  }
};
exports.join = async (req, res, next) => {
  try {
    res
      .status(201)
      .json({ ok: true, progress: await service.joinChallenge(req.user.id, req.params.id) });
  } catch (err) {
    next(err);
  }
};
exports.progress = async (req, res, next) => {
  try {
    res.json({ ok: true, progress: await service.getProgress(req.user.id) });
  } catch (err) {
    next(err);
  }
};
exports.claim = async (req, res, next) => {
  try {
    res.json({ ok: true, progress: await service.claimReward(req.user.id, req.params.id) });
  } catch (err) {
    next(err);
  }
};
