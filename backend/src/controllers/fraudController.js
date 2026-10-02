const FraudService = require('../services/fraudService');

class FraudController {
  static async analyze(req, res, next) {
    try {
      const analysis = await FraudService.analyze(req.user.id, req.params.transactionId);
      res.json({ ok: true, analysis });
    } catch (err) {
      next(err);
    }
  }

  static async getAnalysis(req, res, next) {
    try {
      const analysis = await FraudService.getAnalysis(req.user.id, req.params.transactionId);
      res.json({ ok: true, analysis });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = FraudController;
