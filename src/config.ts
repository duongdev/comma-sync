import { join } from 'node:path'
import { config as envConfig } from '@dotenvx/dotenvx'

const { parsed } = envConfig({
  path: ['.env.local', '.env'],
  overload: false,
  ignore: ['MISSING_ENV_FILE'],
})

if (!parsed) {
  throw new Error('No environment variables found')
}

const parsedEnvs = parsed! as {
  FLEET_URL: string
  FLEET_TOKEN?: string
  DATA_PATH?: string
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_CHAT_ID?: string
}

const DATA_PATH = parsedEnvs.DATA_PATH || join(process.cwd(), 'data')
const DB_PATH = join(DATA_PATH, 'db.json')
const CAMERAS = ['qcamera', 'fcamera', 'ecamera', 'dcamera'] as const

export const config = {
  ...parsedEnvs,
  DATA_PATH,
  DB_PATH,
  CAMERAS,
}
