import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { format } from 'date-fns'
import debug from 'debug'
import ffmpeg from 'fluent-ffmpeg'
import numeral from 'numeral'
import { config } from './config'
import { getDB, saveDB } from './db'
import { telegramBot } from './telegram-bot'
import { sleep } from './utils'

const { VIDEOS_PATH, TMP_PATH, TELEGRAM_CHUNK_SIZE, DELETE_UPLOADED_VIDEOS } =
  config
const IS_TELEGRAM_ENABLED = !!(
  config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID
)
const l = debug('comma-sync:upload-routes')

const telegramQueue = generateTelegramQueue()

export async function uploadRouteVideos() {
  const log = l.extend('uploadRouteVideos')

  const videos = await getVideosToUpload()

  for (const video of videos) {
    try {
      await uploadRouteVideo(video)

      // Delete the video after uploading
      if (DELETE_UPLOADED_VIDEOS) {
        await unlink(join(VIDEOS_PATH, video))
      }
    } catch (error) {
      log('Error uploading video:', video, error)
      continue
    }
  }

  await sleep(5000)
  await uploadRouteVideos()
}

export async function getVideosToUpload() {
  const log = l.extend('getVideosToUpload')

  const db = await getDB()

  const files = await readdir(VIDEOS_PATH)
  const videos = files.filter((file) => {
    if (!file.endsWith('.mp4')) {
      return false
    }

    const [, routeId, , camera] = file.match(/(.*)--(.*)-(.*).mp4/) || []

    if (!routeId || !camera) {
      return false
    }

    if (db.routes[routeId]?.cameras?.[camera]?.processedAt) {
      return false
    }

    return true
  })

  if (videos.length) {
    log(`Found ${videos.length} videos to upload`, videos)
  }

  return videos
}

function generateTelegramQueue() {
  const log = l.extend('TelegramQueue')
  const queue: {
    filePath: string
    caption?: string
    routeId: string
    camera: string
    endTime: number
    resolve: (value: unknown) => void
  }[] = []

  async function addToQueue(video: Omit<(typeof queue)[0], 'resolve'>) {
    return new Promise((resolve) => {
      queue.push({
        ...video,
        resolve: (v: unknown) => {
          resolve(v)
          log('Processed:', video.filePath)
        },
      })
      log('Added to queue:', video.filePath)
    })
  }

  async function process() {
    while (true) {
      if (queue.length === 0) {
        await sleep(5000)
        continue
      }

      log(
        'Queue Items:',
        queue.map((item) => item.filePath),
      )

      const { filePath, caption, camera, routeId, endTime, resolve } = queue[0]
      const { height, width, duration, fileSize } = await getVideoInfo(filePath)

      log(
        `Uploading video to Telegram: ${filePath} (${numeral(fileSize).format('0.0 b')})`,
      )

      try {
        await telegramBot?.sendVideo(
          config.TELEGRAM_CHAT_ID!,
          filePath,
          {
            caption,
            height,
            width,
            duration,
            // @ts-expect-error
            supports_streaming: true,
          },
          { filename: filePath },
        )

        const db = await getDB()
        const uploadedUntil =
          db.routes[routeId]?.cameras?.[camera]?.telegram?.uploadedUntil || 0
        db.routes[routeId] = {
          routeId,
          cameras: {
            ...db.routes[routeId]?.cameras,
            [camera]: {
              ...db.routes[routeId]?.cameras?.[camera],
              telegram: { uploadedUntil: Math.max(endTime, uploadedUntil) },
            },
          },
        }
        await saveDB(db)

        log('Sent video to Telegram:', filePath)
        await unlink(filePath)
      } catch (error) {
        log(
          'Error sending video to Telegram:',
          (error instanceof Error && error.message) || error,
        )
        log('File size:', numeral(fileSize).format('0.0 b'))
      }

      queue.shift()
      resolve(undefined)
    }
  }
  process()

  return { addToQueue }
}

export async function uploadRouteVideo(fileName: string) {
  const log = l.extend('uploadRouteVideo')
  log('Uploading video:', fileName)

  const [, routeId, , camera] = fileName.match(/(.*)--(.*)-(.*).mp4/) || []

  if (!routeId || !camera) {
    log('Invalid file name:', fileName)
    return
  }

  if (IS_TELEGRAM_ENABLED) {
    await uploadToTelegram({ camera, fileName, routeId }, telegramQueue)
  }

  log('Video uploaded:', fileName)
  const db = await getDB()
  db.routes[routeId] = {
    ...db.routes[routeId],
    routeId,
    cameras: {
      ...db.routes[routeId]?.cameras,
      [camera]: {
        ...db.routes[routeId]?.cameras?.[camera],
        processedAt: new Date().toISOString(),
      },
    },
  }
  saveDB(db)
}

async function uploadToTelegram(
  {
    camera,
    fileName,
    routeId,
  }: {
    fileName: string
    routeId: string
    camera: string
  },
  { addToQueue }: ReturnType<typeof generateTelegramQueue>,
) {
  const log = l.extend('uploadToTelegram')
  const videoPath = join(VIDEOS_PATH, fileName)

  if (typeof config.MAX_TMP_GB === 'number') {
    // if the tmp folder is full, wait for it to be cleaned up
    await new Promise((resolve) => {
      let logged = false
      const interval = setInterval(async () => {
        const { size: currentSize } = await stat(TMP_PATH)

        if (currentSize < config.MAX_TMP_GB * 1024 * 1024 * 1024) {
          clearInterval(interval)
          resolve(undefined)
          return
        }

        if (!logged) {
          log('tmp folder is full, waiting for cleanup...')
          logged = true
        }
      }, 5000)
    })
  }

  log('Uploading video to Telegram:', videoPath)

  const { birthtime } = await stat(videoPath)
  const date = format(birthtime, 'yyyy-MM-dd HH:mm:ss')
  const db = await getDB()
  const uploadedUntil =
    db.routes[routeId]?.cameras?.[camera]?.telegram?.uploadedUntil || 0

  async function processChunks() {
    let chunks = -1
    splitVideoToChunks(
      { videoPath, routeId, camera, uploadedUntil },
      async (chunkPath, start, end) => {
        chunks = chunks === -1 ? 1 : chunks + 1
        const caption = `🚗 Route: ${date}\n📷 Camera: ${camera} (${routeId})\n⏱︎ Time: ${numeral(start).format('00:00:00')} - ${numeral(end).format('00:00:00')}`

        await addToQueue({
          filePath: chunkPath,
          caption,
          camera,
          routeId,
          endTime: end,
        })

        chunks -= 1
      },
    )

    while (chunks !== 0) {
      await sleep(5000)
    }
  }

  await processChunks()

  log('Video uploaded to Telegram:', videoPath)
}

async function splitVideoToChunks(
  {
    videoPath,
    chunkSize = TELEGRAM_CHUNK_SIZE,
    routeId,
    camera,
    uploadedUntil = 0,
  }: {
    videoPath: string
    chunkSize?: number
    routeId: string
    camera: string
    uploadedUntil?: number
  },
  onChunkComplete?: (chunkPath: string, start: number, end: number) => void,
) {
  const log = l.extend('splitVideoToChunks')

  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(err)
        return
      }

      const duration = metadata.format.duration!
      const fileSize = metadata.format.size!
      log(
        `Duration: ${numeral(duration).format('00:00:00')}. File size: ${numeral(fileSize).format('0.0 b')}`,
      )
      // let startTime = uploadedUntil
      // let endTime = startTime + 30 * 60

      const splitPart = (
        startTime = uploadedUntil,
        endTime = Math.min(duration, startTime + 30 * 60),
      ) => {
        if (uploadedUntil >= duration || endTime > duration) {
          resolve(undefined)
          return
        }

        const output = join(
          TMP_PATH,
          `${routeId}-${camera}--${numeral(startTime).format('00:00:00').replace(/:/g, '_')}.mp4`,
        )

        log(
          `Creating chunk ${startTime}. Start time: ${numeral(startTime).format('00:00:00')} - End time: ${numeral(endTime).format('00:00:00')} Duration: ${numeral(duration).format('00:00:00')}`,
        )

        ffmpeg(videoPath)
          .inputOptions([`-ss ${startTime}`])
          .outputOptions([`-t ${endTime - startTime}`, '-c copy'])
          .output(output)
          .on('end', async () => {
            const outputSize = await stat(output).then((stats) => stats.size)

            if (outputSize > chunkSize) {
              const deltaEndTime = 120
              if (endTime - deltaEndTime < endTime) {
                log(
                  `Chunk too big ${numeral(outputSize).format('0.0 b')}. Decrease ${numeral(deltaEndTime).format('00:00:00')} ${numeral(deltaEndTime).format('00:00:00')}...`,
                )
                splitPart(startTime, endTime - deltaEndTime)
                return
              }
            }

            log(
              `Chunk created. Start time: ${numeral(startTime).format('00:00:00')} - End time: ${numeral(endTime).format('00:00:00')} (${numeral(outputSize).format('0.0 b')})`,
              output,
            )

            onChunkComplete?.(output, startTime, endTime)

            if (
              Math.abs(endTime - duration) <= 2 ||
              startTime >= endTime ||
              endTime >= duration
            ) {
              resolve(undefined)
              return
            }

            splitPart(endTime, Math.min(startTime + 30 * 60, duration))
          })
          .on('error', (error) => {
            reject(error)
          })
          .run()
      }

      splitPart()
    })
  })
}

async function getVideoInfo(videoPath: string): Promise<{
  fileSize: number
  duration: number
  height: number
  width: number
}> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(err)
        return
      }

      const fileSize = metadata.format.size!
      const duration = Math.ceil(metadata.format.duration!)
      const height = metadata.streams[0].height!
      const width = metadata.streams[0].width!

      resolve({ fileSize, duration, height, width })
    })
  })
}

export async function cleanUpTempUploadFiles() {
  const log = l.extend('cleanUpTempUploadFiles')

  log('Cleaning up temp uploads files in:', TMP_PATH)

  const files = await readdir(TMP_PATH)

  for (const file of files) {
    await unlink(join(TMP_PATH, file))
    log('Removed file:', file)
  }
}
