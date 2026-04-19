const DEFAULT_COOLDOWN = 60000;

function requestBalance(bot) {
  bot.chat('/bal');
}

function decideAmount(context) {
  if (!context) return 10;
  if (context.reason === 'reward') return Math.max(5, Math.min(250, context.value || 25));
  if (context.reason === 'salary') return Math.max(10, Math.min(1000, context.value || 100));
  return Math.max(1, Math.min(100, context.value || 10));
}

async function pay(bot, memory, player, amount, reason, cooldownMs) {
  if (!player) throw new Error('Missing pay target');
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Invalid pay amount');
  }
  const key = player + ':' + (reason || 'manual');
  const cooldown = cooldownMs || DEFAULT_COOLDOWN;
  if (!memory.canPay(key, cooldown)) {
    throw new Error('Payment cooldown active for ' + key);
  }
  bot.chat('/pay ' + player + ' ' + Math.floor(value));
  memory.markPaid(key);
  memory.setLastAction('paid ' + player + ' ' + Math.floor(value));
}

async function rewardPlayer(bot, memory, player, value) {
  const amount = decideAmount({ reason: 'reward', value });
  await pay(bot, memory, player, amount, 'reward', DEFAULT_COOLDOWN);
}

async function teamSalary(bot, memory, players, value) {
  const amount = decideAmount({ reason: 'salary', value });
  for (const player of players) {
    if (memory.isTrusted(player)) {
      await pay(bot, memory, player, amount, 'salary', 300000);
    }
  }
}

module.exports = {
  requestBalance,
  decideAmount,
  pay,
  rewardPlayer,
  teamSalary
};