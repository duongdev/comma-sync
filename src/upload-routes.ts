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

  const files = await readdir(VIDEOS_PATH)
  const videos = files.filter((file) => file.endsWith('.mp4'))

  if (videos.length) {
    log(`Found ${videos.length} videos to upload`, videos)
  }

  return videos
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
    await uploadToTelegram({ camera, fileName, routeId })
  }

  log('Video uploaded:', fileName)
}

async function uploadToTelegram({
  camera,
  fileName,
  routeId,
}: {
  fileName: string
  routeId: string
  camera: string
}) {
  const log = l.extend('uploadToTelegram')
  const videoPath = join(VIDEOS_PATH, fileName)

  log('Uploading video to Telegram:', videoPath)

  const { birthtime } = await stat(videoPath)
  const date = format(birthtime, 'yyyy-MM-dd HH:mm:ss')
  const { height, width, duration } = await getVideoInfo(videoPath)
  let db = await getDB()
  let uploadedUntil =
    db.routes[routeId]?.cameras[camera]?.telegram?.uploadedUntil || 0

  await splitVideoToChunks(
    { videoPath, routeId, camera, uploadedUntil },
    async (chunkPath, start, end) => {
      const caption = `🚗 Route: ${date}\n📷 Camera: ${camera} (${routeId})\n⏱︎ Time: ${numeral(start).format('00:00:00')} - ${numeral(end).format('00:00:00')}`

      telegramBot
        ?.sendVideo(
          config.TELEGRAM_CHAT_ID!,
          chunkPath,
          {
            caption,
            height,
            width,
            duration,
            // @ts-expect-error
            supports_streaming: true,
          },
          { contentType: 'video/mp4', filename: fileName },
        )
        .then(async () => {
          db = await getDB()
          uploadedUntil =
            db.routes[routeId]?.cameras[camera]?.telegram?.uploadedUntil || 0
          db.routes[routeId] = {
            routeId,
            cameras: {
              ...db.routes[routeId]?.cameras,
              [camera]: {
                telegram: { uploadedUntil: Math.max(end, uploadedUntil) },
              },
            },
          }
          await saveDB(db)

          log('Sent video to Telegram:', fileName)
          log('Removed chunk:', chunkPath)
          await unlink(chunkPath)
        })
        .catch(async (error) => {
          log('Error sending video to Telegram:', error.message)
          const chunkFileSize = await stat(chunkPath).then(
            (stats) => stats.size,
          )
          log('Chunk size:', numeral(chunkFileSize).format('0.0 b'))
        })
    },
  )
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
        `Duration: ${duration}. File size: ${numeral(fileSize).format('0.0 b')}`,
      )
      let startTime = uploadedUntil
      let endTime = startTime + 30 * 60

      const splitPart = () => {
        const output = join(TMP_PATH, `${routeId}-${camera}--${startTime}.mp4`)

        log(
          `Creating chunk ${startTime}. Start time: ${startTime} - End time: ${endTime} Duration: ${duration}`,
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
                  `Chunk too big ${numeral(outputSize).format('0.0 b')}. Decrease ${deltaEndTime} ${numeral(deltaEndTime).format('00:00:00')}...`,
                )
                endTime -= deltaEndTime
                splitPart()
                return
              }
            }

            log(
              `Chunk created. Start time: ${numeral(startTime).format('0.0')} - End time: ${numeral(endTime).format('0.0')} (${numeral(outputSize).format('0.0 b')})`,
              output,
            )

            onChunkComplete?.(output, startTime, endTime)

            if (endTime >= duration) {
              resolve(undefined)
              return
            }

            startTime = endTime
            endTime = Math.min(startTime + 30 * 60, duration)

            splitPart()
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
