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

const CAMERAS = ['fcamera', 'ecamera', 'dcamera'] as const
const DATA_PATH = parsedEnvs.DATA_PATH || join(process.cwd(), 'data')
const DB_PATH = join(DATA_PATH, 'db.json')
const VIDEOS_PATH = join(DATA_PATH, 'videos')
const TMP_PATH = join(DATA_PATH, 'tmp')
const TELEGRAM_CHUNK_SIZE = 35 * 1024 * 1024
const TELEGRAM_MAX_VIDEOS_PER_MESSAGE = 1

export const config = {
  ...parsedEnvs,
  DATA_PATH,
  DB_PATH,
  CAMERAS,
  VIDEOS_PATH,
  TMP_PATH,
  TELEGRAM_CHUNK_SIZE,
  TELEGRAM_MAX_VIDEOS_PER_MESSAGE,
}
