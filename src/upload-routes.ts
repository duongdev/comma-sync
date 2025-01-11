import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { format } from 'date-fns'
import debug from 'debug'
import ffmpeg from 'fluent-ffmpeg'
import { config } from './config'
import { getDB, saveDB } from './db'
import { telegramBot } from './telegram-bot'
import { sleep } from './utils'

const {
  VIDEOS_PATH,
  TMP_PATH,
  TELEGRAM_CHUNK_SIZE,
  TELEGRAM_MAX_VIDEOS_PER_MESSAGE,
  DELETE_UPLOADED_VIDEOS,
} = config
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

  const { birthtime, size } = await stat(videoPath)
  const date = format(birthtime, 'yyyy-MM-dd HH:mm:ss')
  // const fileSize = numeral(size).format('0.0b')
  const totalChunks = Math.ceil(size / TELEGRAM_CHUNK_SIZE)
  const { height, width, duration } = await getVideoInfo(videoPath)
  let db = await getDB()
  let uploadedChunks =
    db.routes[routeId]?.cameras[camera]?.telegram?.uploadedChunks || 0

  if (uploadedChunks >= totalChunks) {
    log('Video already uploaded:', fileName)
    return
  }

  // if (totalChunks === 1) {
  //   const caption = `🚗 Route: ${date}\n📷 Camera: ${camera}\n💽 Size: ${fileSize}`
  //   await telegramBot?.sendVideo(
  //     config.TELEGRAM_CHAT_ID!,
  //     videoPath,
  //     {
  //       caption,
  //       height,
  //       width,
  //       duration,
  //       // @ts-expect-error
  //       supports_streaming: true,
  //     },
  //     { contentType: 'video/mp4', filename: fileName },
  //   )

  //   return
  // }

  let messageIndex = 0
  const totalMessages = Math.ceil(totalChunks / TELEGRAM_MAX_VIDEOS_PER_MESSAGE)

  await splitVideoToChunks(
    { videoPath, routeId, camera, startChunkIndex: uploadedChunks },
    (chunkPath) => {
      const caption = `🚗 Route: ${date}\n📷 Camera: ${camera} (${routeId})\n💽 Part: ${++messageIndex}/${totalMessages}`

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
          uploadedChunks++

          db = await getDB()
          db.routes[routeId] = {
            routeId,
            cameras: {
              ...db.routes[routeId]?.cameras,
              [camera]: {
                telegram: { uploadedChunks },
              },
            },
          }
          await saveDB(db)

          log('Sent video to Telegram:', fileName)
          log('Removed chunk:', chunkPath)
          await unlink(chunkPath)
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
    startChunkIndex = 0,
  }: {
    videoPath: string
    chunkSize?: number
    routeId: string
    camera: string
    startChunkIndex?: number
  },
  onChunkComplete?: (chunkPath: string) => void,
) {
  const log = l.extend('splitVideoToChunks')

  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(err)
        return
      }

      const fileSize = metadata.format.size!
      const duration = metadata.format.duration!
      const totalParts = Math.ceil(fileSize / chunkSize)
      const targetDuration = duration / totalParts

      let startTime = startChunkIndex * targetDuration
      let chunkIndex = startChunkIndex

      function splitPart() {
        const endTime = Math.min(startTime + targetDuration, duration)

        const output = join(TMP_PATH, `${routeId}-${camera}--${chunkIndex}.mp4`)

        ffmpeg(videoPath)
          // .setStartTime(startTime)
          // .setDuration(endTime - startTime)
          .inputOptions([`-ss ${startTime}`])
          .outputOptions([`-to ${endTime}`, '-c copy'])
          .output(output)
          .on('end', () => {
            log('Chunk created:', output)

            onChunkComplete?.(output)

            startTime = endTime
            chunkIndex++

            if (startTime < duration) {
              splitPart()
            } else {
              resolve(undefined)
            }
          })
          .on('error', reject)
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
