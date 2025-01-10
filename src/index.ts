import { rm } from 'node:fs/promises'
import Debug from 'debug'
import { config } from './config'
import { verifyDBFile } from './db'
import { cleanUpTempDownloadFiles, downloadRoutes } from './download-routes'
import { verifyPath } from './fs'
import { getTelegramBotInfo } from './telegram-bot'
import { uploadRouteVideos } from './upload-routes'

Debug.enable('comma-sync:*')
const debug = Debug('comma-sync')

async function main() {
  const log = debug.extend('main')
  log('Starting...')

  // Verify the database file exists
  await verifyDBFile()
  verifyPath(config.VIDEOS_PATH)
  verifyPath(config.TMP_PATH)
  await cleanUpTempDownloadFiles()
  await rm(config.TMP_PATH, { force: true, recursive: true })

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
