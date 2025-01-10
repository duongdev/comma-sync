import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { format } from 'date-fns'
import debug from 'debug'
import ffmpeg from 'fluent-ffmpeg'
import numeral from 'numeral'
import { config } from './config'
import { telegramBot } from './telegram-bot'
import { sleep } from './utils'

const {
  VIDEOS_PATH,
  TMP_PATH,
  TELEGRAM_CHUNK_SIZE,
  TELEGRAM_MAX_VIDEOS_PER_MESSAGE,
} = config
const IS_TELEGRAM_ENABLED = !!(
  config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID
)
const l = debug('comma-sync:upload-routes')

export async function uploadRouteVideos() {
  const log = l.extend('uploadRouteVideos')
  log('Uploading route videos...')

  const videos = await getVideosToUpload()

  for (const video of videos) {
    await uploadRouteVideo(video)
    // Delete the video after uploading
    await unlink(join(VIDEOS_PATH, video))
  }

  log('Route videos uploaded')
  await sleep(5000)
  await uploadRouteVideos()
}

export async function getVideosToUpload() {
  const log = l.extend('getVideosToUpload')

  log('Getting videos to upload from:', VIDEOS_PATH)

  const files = await readdir(VIDEOS_PATH)
  const videos = files.filter((file) => file.endsWith('.mp4'))

  log(`Found ${videos.length} videos to upload`, videos)

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
  const fileSize = numeral(size).format('0.0b')
  const totalChunks = Math.ceil(size / TELEGRAM_CHUNK_SIZE)
  const { height, width, duration } = await getVideoInfo(videoPath)

  if (totalChunks === 1) {
    const caption = `🚗 Route: ${date}\n📷 Camera: ${camera}\n💽 Size: ${fileSize}`
    await telegramBot?.sendVideo(
      config.TELEGRAM_CHAT_ID!,
      videoPath,
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

    return
  }

  let messageIndex = 0
  const totalMessages = Math.ceil(totalChunks / TELEGRAM_MAX_VIDEOS_PER_MESSAGE)

  await splitVideoToChunks({ videoPath, routeId, camera }, (chunkPath) => {
    const caption = `🚗 Route: ${date}\n📷 Camera: ${camera}\n💽 Part: ${++messageIndex}/${totalMessages}`

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
      .finally(() => {
        unlink(chunkPath)
      })
  })
}

async function splitVideoToChunks(
  {
    videoPath,
    chunkSize = TELEGRAM_CHUNK_SIZE,
    routeId,
    camera,
  }: { videoPath: string; chunkSize?: number; routeId: string; camera: string },
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
      const targetDuration = (chunkSize / fileSize) * duration

      let startTime = 0
      let chunkIndex = 0

      function splitPart() {
        const endTime = Math.min(startTime + targetDuration, duration)

        const output = join(TMP_PATH, `${routeId}-${camera}--${chunkIndex}.mp4`)

        ffmpeg(videoPath)
          .setStartTime(startTime)
          .setDuration(endTime - startTime)
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
