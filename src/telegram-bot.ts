import { execSync } from 'child_process'
import { statSync } from 'fs'
import { format } from 'date-fns'
import TelegramBot from 'node-telegram-bot-api'
import numeral from 'numeral'
import { config } from './config'
import { DEFAULT_DB, getDB, saveDB } from './db'
import { getRoutes } from './download-routes'
import { telegramQueue } from './upload-routes'

const debug = require('debug')('comma-sync:telegram-bot')

debug('Starting Telegram bot...')

let initializedAt = Date.now()

export const telegramBot = config.TELEGRAM_BOT_TOKEN
  ? new TelegramBot(config.TELEGRAM_BOT_TOKEN, {
      polling: true,
      baseApiUrl: config.TELEGRAM_API_URL,
    })
  : null

export async function getTelegramBotInfo() {
  if (!telegramBot) {
    return null
  }

  initializedAt = Date.now()

  return telegramBot.getMe()
}

export async function sendTelegramMessage(
  message: string,
  {
    chatId = config.TELEGRAM_CHAT_ID,
    ...options
  }: TelegramBot.SendMessageOptions & { chatId?: string } = {},
) {
  if (!telegramBot || !chatId) {
    return
  }

  const log = debug.extend('sendTelegramMessage')
  log('Sending message to chat:', chatId, message, options)

  telegramBot.sendMessage(chatId, message, options)
}

telegramBot?.onText(/\/chat_id/, (msg) => {
  const chatId = msg.chat.id
  debug('Received /start command from chat:', chatId)
  telegramBot?.sendMessage(chatId, `Your chat ID is: ${chatId}`)
})

telegramBot?.on('message', async (msg) => {
  const chatId = msg.chat.id
  debug('Received message from chat:', chatId, msg.text)

  switch (msg.text) {
    case '/upload_queue': {
      const items = telegramQueue.queue.map((item) => ({
        ...item,
        size: statSync(item.filePath).size,
      }))
      const message =
        items.length === 0
          ? 'Upload queue is empty'
          : `Upload queue:\n${items.map((item, index) => `${index + 1}. ${item.routeId} - ${item.camera} - ${numeral(item.size).format('0.0 b')}`).join('\n')}`
              .replace(/\./g, '\\.')
              .replace(/\-/g, '\\-')

      await telegramBot?.sendMessage(chatId, message, {
        parse_mode: 'MarkdownV2',
      })

      return
    }
    case '/routes': {
      const db = await getDB()
      const routeIds = (await getRoutes())
        .map((routeId) => routeId.split('--')[0])
        .concat(Object.keys(db.routes))
        .sort()

      debug({ routeIds, db: db.routes })

      const routes = routeIds.map((routeId) => ({
        routeId,
        cameras: db.routes?.[routeId]?.cameras
          ? Object.entries(db.routes?.[routeId]?.cameras)
              .map(
                ([camera, { downloadedAt, processedAt, telegram }]) =>
                  `\n__${camera}__\nDownloaded: ${downloadedAt ? `${format(new Date(downloadedAt), 'yyyy-MM-dd HH:mm:ss')}` : '-'}\nProcessed: ${processedAt ? `${format(new Date(processedAt), 'yyyy-MM-dd HH:mm:ss')}` : '-'}\nUploaded: ${telegram?.uploadedUntil ? `${numeral(telegram.uploadedUntil).format('00:00:00')}` : '-'}`,
              )
              .join('\n')
          : '-',
      }))

      for (const route of routes) {
        const message = `*${route.routeId}*\n${route.cameras}`
          .replace(/\./g, '\\.')
          .replace(/\-/g, '\\-')

        await telegramBot?.sendMessage(chatId, message, {
          parse_mode: 'MarkdownV2',
        })
      }

      return
    }
    case 'reset_db': {
      await saveDB(DEFAULT_DB)
      return telegramBot?.sendMessage(chatId, 'Database reset')
    }
    case '/restart': {
      // Don't restart if the bot was initialized less than 30s ago
      if (Date.now() - initializedAt < 30000) {
        return
      }
      await telegramBot?.sendMessage(chatId, 'Restarting...')
      return process.exit(1)
    }

    case '/update': {
      await telegramBot?.sendMessage(chatId, 'Updating...')

      // pull latest changes from git
      const result = execSync('git reset --hard && git clean -f -d && git pull')

      await telegramBot?.sendMessage(chatId, result.toString())
      await telegramBot?.sendMessage(chatId, 'Restarting...')

      return process.exit(1)
    }
    default: {
      return
    }
  }
})

telegramBot?.on('callback_query', async (query) => {
  const chatId = query.from.id
  const data = query.data
  debug('Received callback query from chat:', chatId, data)

  if (data?.startsWith('/reupload:')) {
    const videoPath = data.slice('/reupload:'.length)
    const [, routeId, , camera] = videoPath.match(/(.*)--(.*)-(.*).mp4/) || []

    debug('Reuploading route:', routeId, camera)

    const db = await getDB()

    try {
      debug('Current DB:', db.routes?.[routeId]?.cameras[camera])
      delete db.routes?.[routeId]?.cameras[camera]?.telegram?.uploadedUntil
      delete db.routes?.[routeId]?.cameras[camera]?.processedAt
      await saveDB(db)
    } catch (error) {
      debug('Error reuploading route:', error)
    }

    telegramBot?.sendMessage(chatId, `Reuploading route: ${videoPath}`)
  }

  if (data?.startsWith('/redownload:')) {
    const videoPath = data.slice('/reupload:'.length)
    const [, routeId] = videoPath.match(/(.*)--(.*)-(.*).mp4/) || []
    const db = await getDB()

    if (db.routes[routeId]) {
      delete db.routes[routeId]
      await saveDB(db)
    }

    telegramBot?.sendMessage(chatId, `Reuploading route: ${videoPath}`)
  }

  return telegramBot?.answerCallbackQuery(query.id)
})
