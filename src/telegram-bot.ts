import TelegramBot from 'node-telegram-bot-api'
import { config } from './config'

const debug = require('debug')('comma-sync:telegram-bot')

debug('Starting Telegram bot...')

export const telegramBot = config.TELEGRAM_BOT_TOKEN
  ? new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true })
  : null

export async function getTelegramBotInfo() {
  if (!telegramBot) {
    return null
  }

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

telegramBot?.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id
  debug('Received /start command from chat:', chatId)
  telegramBot?.sendMessage(chatId, `Your chat ID is: ${chatId}`)
})
