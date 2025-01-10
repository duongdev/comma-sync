import { join } from 'path'
import Debug from 'debug'
import { config } from './config'
import { verifyDBFile } from './db'
import {
  cleanUpTempDownloadFiles,
  downloadRouteVideos,
  downloadRoutes,
  getRoutes,
} from './download-routes'
import { verifyPath } from './fs'
import { getTelegramBotInfo } from './telegram-bot'
import { getVideosToUpload, uploadRouteVideos } from './upload-routes'

Debug.enable('comma-sync:*')
const debug = Debug('comma-sync')

async function main() {
  const log = debug.extend('main')
  log('Starting...')

  // Verify the database file exists
  await verifyDBFile()
  verifyPath(config.DATA_PATH, 'videos')
  verifyPath(config.DATA_PATH, 'tmp')
  await cleanUpTempDownloadFiles()

  // Initialize telegram bot
  const botInfo = await getTelegramBotInfo()
  if (botInfo) {
    log('Telegram bot started:', botInfo.username)
    // sendTelegramMessage('🚀 Comma Sync started')
  } else {
    log('Telegram bot not enabled')
  }

  downloadRoutes()
  uploadRouteVideos()
}

main().catch((error) => {
  console.error('An error occurred:', error)
})
