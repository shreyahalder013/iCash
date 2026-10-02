const prisma = require('../prisma');

async function listChallenges(userId) {
  const challenges = await prisma.savingChallenge.findMany({
    where: { active: true },
    include: { progress: { where: { user_id: userId } } },
  });
  return challenges.map((challenge) => ({ ...challenge, progress: challenge.progress[0] || null }));
}

async function joinChallenge(userId, challengeId) {
  const challenge = await prisma.savingChallenge.findUnique({ where: { id: challengeId } });
  if (!challenge || !challenge.active)
    throw Object.assign(new Error('Saving challenge not found.'), { status: 404 });
  return prisma.challengeProgress.upsert({
    where: { challenge_id_user_id: { challenge_id: challengeId, user_id: userId } },
    create: { challenge_id: challengeId, user_id: userId },
    update: {},
  });
}

async function getProgress(userId) {
  return prisma.challengeProgress.findMany({
    where: { user_id: userId },
    include: { challenge: true },
    orderBy: { joined_at: 'desc' },
  });
}

async function claimReward(userId, progressId) {
  const progress = await prisma.challengeProgress.findFirst({
    where: { id: progressId, user_id: userId },
    include: { challenge: true },
  });
  if (!progress) throw Object.assign(new Error('Challenge progress not found.'), { status: 404 });
  if (
    progress.completed_at ||
    (progress.challenge.target_amount &&
      Number(progress.current_amount) >= Number(progress.challenge.target_amount))
  ) {
    return prisma.challengeProgress.update({
      where: { id: progress.id },
      data: { completed_at: progress.completed_at || new Date(), xp: { increment: 100 } },
    });
  }
  throw Object.assign(new Error('Challenge is not complete yet.'), { status: 400 });
}

module.exports = { listChallenges, joinChallenge, getProgress, claimReward };
