import { Context, Schema, h } from 'koishi'

export const name = 'delaywelcome'
export const usage = '延迟欢迎新成员加入群组，避免连续刷屏'

export interface Config {
  delay: number
  minDelay: number
  template: string
  maxUsers: number
  maxWaitTime: number
}

export const Config: Schema<Config> = Schema.object({
  delay: Schema.number()
    .default(8)
    .description('欢迎消息延迟发送的时间（秒）'),
  minDelay: Schema.number()
    .default(5)
    .description('当有多人连续加群时，最小的延迟时间（秒）'),
  maxUsers: Schema.number()
    .default(20)
    .description('同时欢迎的最大人数'),
  maxWaitTime: Schema.number()
    .default(20)
    .description('最大等待时间（秒），超过这个时间将立即发送欢迎消息'),
  template: Schema.string()
    .default('欢迎 {at} 加入 {group}！\n当前时间：{time}')
    .description('欢迎消息模板，支持 {user}、{id}、{group_id}、{group}、{time}、{at} 变量，{at} 将被替换为所有新成员的@标记'),
})
function getNotEmptyText(defaultName: string, ...texts: (string | undefined | null)[]): string {
  for (const text of texts) {
    if (text != null && text.length > 0 && text !== defaultName) {
      return text;
    }
  }
  return defaultName;
}
export function apply(ctx: Context, config: Config) {
  interface TimerInfo {
    timer: NodeJS.Timeout
    endTime: number
    pendingUsers: Array<{
      userId: string
      userName: string
    }>
  }

  const timers = new Map<string, TimerInfo>()
  const welcomedUsers = new Set<string>()

  ctx.on('guild-member-added', async (session) => {
    if (!session.guildId || !session.userId) return

    const key = session.guildId
    const now = Date.now()
    const userId = session.author?.id ?? session.event.user?.id ?? session.userId;
    const guildId = session.event.guild?.id ?? session.guildId;
    const groupName = (await session.bot.getGuild(guildId)).name ?? session.event.guild?.name ?? "";

    // 如果用户已经被欢迎过，则不再欢迎
    if (welcomedUsers.has(userId)) return

    let userName = getNotEmptyText(
      userId,
      session.event?.member?.nick,
      session.event?.member?.name,
      session.event?.user?.nick,
      session.event?.user?.name,
      session.author?.nick,
      session.author?.name,
      session.username
    );
    if (userName === userId) {
      userName = await session.bot.getGuildMember(guildId, userId).then((member) => {
        return getNotEmptyText(
          userId,
          member.nick,
          member.name,
          member.user?.nick,
          member.user?.name
        );
      });
    }
    // 格式化当前时间
    const currentTime = new Date().toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    })

    const userInfo = { userId, userName }

    // 检查是否已有计时器
    const existingTimer = timers.get(key)
    if (existingTimer) {
      // 添加新用户到待欢迎列表
      existingTimer.pendingUsers.push(userInfo)

      // 计算剩余时间（毫秒）
      const remainingTime = existingTimer.endTime - now

      // 如果已经超过最大等待时间，立即发送欢迎消息
      if (now - (existingTimer.endTime - config.delay * 1000) > config.maxWaitTime * 1000) {
        clearTimeout(existingTimer.timer)

        const validUsers = []
        for (const user of existingTimer.pendingUsers) {
          try {
            await session.bot.getGuildMember(guildId, user.userId)
            validUsers.push(user)
          } catch (e) {
            continue
          }
        }
        const usersToMention = validUsers.slice(0, config.maxUsers)

        usersToMention.forEach(user => welcomedUsers.add(user.userId))

        const welcomeMessage = config.template
          .replace(/{group_id}/g, guildId)
          .replace(/{group}/g, groupName)
          .replace(/{time}/g, currentTime)
          .replace(/{at}/g, () => usersToMention.map(u => h.at(u.userId)).join(' '))

        session.send(h.parse(welcomeMessage))
        timers.delete(key)
        return
      }

      // 如果剩余时间小于最小延迟时间，则重置为最小延迟时间
      if (remainingTime < config.minDelay * 1000) {
        clearTimeout(existingTimer.timer)

        const newEndTime = now + config.minDelay * 1000
        const newTimer = setTimeout(async () => {
          // 检查用户是否仍在群组中，并获取要@的用户列表（限制最大人数）
          const validUsers = []
          for (const user of existingTimer.pendingUsers) {
            try {
              await session.bot.getGuildMember(guildId, user.userId)
              validUsers.push(user)
            } catch (e) {
              // 用户不在群组中，跳过
              continue
            }
          }
          const usersToMention = validUsers.slice(0, config.maxUsers)

          // 记录已欢迎的用户
          usersToMention.forEach(user => welcomedUsers.add(user.userId))

          // 准备欢迎消息
          const welcomeMessage = config.template
            .replace(/{group_id}/g, guildId)
            .replace(/{group}/g, groupName)
            .replace(/{time}/g, currentTime)
            .replace(/{at}/g, () => usersToMention.map(u => h.at(u.userId)).join(' '))

          session.send(h.parse(welcomeMessage))
          timers.delete(key)
        }, config.minDelay * 1000)

        timers.set(key, { timer: newTimer, endTime: newEndTime, pendingUsers: existingTimer.pendingUsers })
      }
    } else {
      // 创建新的计时器
      const endTime = now + config.delay * 1000
      const timer = setTimeout(async () => {
        const timerInfo = timers.get(key)
        if (timerInfo) {
          // 检查用户是否仍在群组中，并获取要@的用户列表（限制最大人数）
          const validUsers = []
          for (const user of timerInfo.pendingUsers) {
            try {
              await session.bot.getGuildMember(guildId, user.userId)
              validUsers.push(user)
            } catch (e) {
              // 用户不在群组中，跳过
              continue
            }
          }
          const usersToMention = validUsers.slice(0, config.maxUsers)

          // 记录已欢迎的用户
          usersToMention.forEach(user => welcomedUsers.add(user.userId))

          // 准备欢迎消息
          const welcomeMessage = config.template
            .replace(/{group_id}/g, guildId)
            .replace(/{group}/g, groupName)
            .replace(/{time}/g, currentTime)
            .replace(/{at}/g, () => usersToMention.map(u => h.at(u.userId)).join(' '))

          session.send(h.parse(welcomeMessage))
          timers.delete(key)
        }
      }, config.delay * 1000)

      timers.set(key, { timer, endTime, pendingUsers: [userInfo] })
    }
  })

  // 清理计时器
  ctx.on('dispose', () => {
    for (const { timer } of timers.values()) {
      clearTimeout(timer)
    }
    timers.clear()
    welcomedUsers.clear()
  })
}