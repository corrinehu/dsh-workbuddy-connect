/** Plugin-card copy registered under the settings.workbuddy locale namespace. */

export const en = {
  title: 'WorkBuddy Connect',
  intro: 'WorkBuddy (CodeBuddy) subscription models, following the desktop app sign-in.',
  expand: 'Expand',
  collapse: 'Collapse',
  loading: 'Loading account…',
  signedOut: 'Not signed in',
  signedOutHint: 'Sign in once in the WorkBuddy desktop app; this plugin follows that sign-in automatically.',
  signedInAs: 'Signed in as {nickname}',
  accessTokenExpires: 'Access token expires {time} (refresh is automatic)',
  creditsHeading: 'Remaining credit',
  creditsTotal: 'Total: {total}',
  percentRemaining: '{percent}% remaining',
  exactRemaining: '{remain} / {size} remaining',
  creditPackageUnknownSize: '{remain} remaining',
  creditsError: 'Credit unavailable: {message}',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  requestFailed: 'Request failed',
  accountHeading: 'Account',
} as const

export type WorkBuddySettingsKey = keyof typeof en

export const zh: Record<WorkBuddySettingsKey, string> = {
  title: 'WorkBuddy Connect',
  intro: '使用 WorkBuddy（CodeBuddy）订阅的模型，自动跟随桌面 App 的登录。',
  expand: '展开',
  collapse: '收起',
  loading: '正在读取账号…',
  signedOut: '未登录',
  signedOutHint: '在 WorkBuddy 桌面 App 里登录一次即可，插件会自动跟随当前登录的账号。',
  signedInAs: '已登录：{nickname}',
  accessTokenExpires: '访问令牌 {time} 过期（自动续期）',
  creditsHeading: '剩余积分',
  creditsTotal: '合计：{total}',
  percentRemaining: '剩余 {percent}%',
  exactRemaining: '剩余 {remain} / {size}',
  creditPackageUnknownSize: '剩余 {remain}',
  creditsError: '积分查询失败：{message}',
  refresh: '刷新',
  refreshing: '正在刷新…',
  requestFailed: '请求失败',
  accountHeading: '账号',
}
