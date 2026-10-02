const service = require('../services/splitService');

const run = (fn) => async (req, res, next) => {
  try {
    return res.json({ ok: true, ...(await fn(req)) });
  } catch (err) {
    return next(err);
  }
};

const SplitController = {
  createGroup: run(async (req) => {
    if (!req.body.name || typeof req.body.name !== 'string')
      throw Object.assign(new Error('Group name is required.'), { status: 400 });
    return {
      group: await service.createGroup(
        req.user.id,
        req.body.name.trim(),
        req.body.memberIds || req.body.members || []
      ),
    };
  }),
  addMember: run(async (req) => ({
    member: await service.addMember(
      req.user.id,
      req.params.groupId,
      req.body.userId || req.body.memberId
    ),
  })),
  createExpense: run(async (req) => ({
    expense: await service.createExpense(req.user.id, req.params.groupId, req.body),
  })),
  optimize: run(async (req) => service.getOptimization(req.user.id, req.params.groupId)),
  calculate: run(async (req) => ({
    shares: service.calculateSplits(
      req.body.totalAmount ?? req.body.amount,
      req.body.memberIds,
      req.body.method,
      req.body.values || req.body.shares || []
    ),
  })),
  settlePayment: run(async (req) => ({
    payment: await service.settlePayment(req.user.id, req.params.paymentId),
  })),
};

module.exports = SplitController;
