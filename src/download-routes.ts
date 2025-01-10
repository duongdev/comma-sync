import { createWriteStream } from 'node:fs'
import { readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import axios from 'axios'
import numeral from 'numeral'
import { config } from './config'
import { getDB, saveDB } from './db'
import { sleep } from './utils'

const CHUNK_TIMEOUT_MS = 5000

const debug = require('debug')('comma-sync:routes')

export async function downloadRoutes() {
  const log = debug.extend('downloadRoutes')

  try {
    const routes = await getRoutes()

    for (const routeId of routes) {
      log('Uploading route:', routeId)
      await downloadRouteVideos(routeId).catch((error) => {
        log('Error downloading route videos:', error)
      })
    }
  } catch (error) {
    log('Error downloading routes:', error)
  }

  await sleep(5000)
  await downloadRoutes()
}

export async function getRoutes() {
  const log = debug.extend('getRoutes')
  const url = `${config.FLEET_URL}/api/routes?bypass_token=${config.FLEET_TOKEN}`

  log('Getting routes from:', url)

  const response = await axios.get<string[]>(url)

  const routes = response.data.sort()
  log(`Got ${response.data.length} routes:`, routes)

  return routes
}

export async function downloadRouteVideos(routeId: string) {
  const log = debug.extend(`downloadRouteVideos:${routeId}`)

  for (const camera of config.CAMERAS) {
    let db = await getDB()

    // Skip if the camera video has already been downloaded
    if (db.routes[routeId]?.cameras[camera]?.downloadedAt) {
      log('Camera video already downloaded:', camera)
      continue
    }

    log('Downloading route camera:', camera)

    const videoUrl = `${config.FLEET_URL}/footage/full/${camera}/${routeId}?bypass_token=${config.FLEET_TOKEN}`

    log('Camera video URL:', videoUrl)

    let lastChunkAt = Date.now()
    const response = await axios.get(videoUrl, {
      responseType: 'stream',
      onDownloadProgress() {
        lastChunkAt = Date.now()
      },
      timeout: CHUNK_TIMEOUT_MS,
    })
    const FILE_NAME = `${routeId}-${camera}.mp4`
    const VIDEOS_PATH = join(config.DATA_PATH, 'videos')
    const TMP_FILE_PATH = join(VIDEOS_PATH, `${FILE_NAME}.tmp`)

    const writeStream = createWriteStream(TMP_FILE_PATH)

    response.data.pipe(writeStream)

    const success = await new Promise((resolve) => {
      // Abort the download if no chunks are received for 5 seconds
      const interval = setInterval(() => {
        if (Date.now() - lastChunkAt > CHUNK_TIMEOUT_MS) {
          log('No chunks received for 5 seconds, aborting download')
          response.data.destroy()
          clearInterval(interval)
          unlink(TMP_FILE_PATH)
          resolve(false)
          return
        }

        log(`Downloaded ${numeral(writeStream.bytesWritten).format('0.0b')}`)
      }, CHUNK_TIMEOUT_MS)
      writeStream.on('finish', () => {
        clearInterval(interval)
        resolve(true)
      })
    })

    if (!success) {
      return
    }

    // Rename the file
    await new Promise((resolve, reject) => {
      writeStream.close((error) => {
        if (error) {
          reject(error)
        } else {
          rename(
            join(VIDEOS_PATH, `${FILE_NAME}.tmp`),
            join(VIDEOS_PATH, FILE_NAME),
          )
          resolve(undefined)
        }
      })
    })

    // Log the downloaded video
    db = await getDB()
    db.routes[routeId] = {
      routeId,
      cameras: {
        ...db.routes[routeId]?.cameras,
        [camera]: {
          downloadedAt: new Date().toISOString(),
        },
      },
    }
    await saveDB(db)

    log(
      `Downloaded camera video: ${FILE_NAME} (${Math.round(writeStream.bytesWritten / 1024 / 1024)} MBs)`,
    )
  }
}

export async function cleanUpTempDownloadFiles() {
  const log = debug.extend('cleanUpTempFiles')
  const VIDEOS_PATH = join(config.DATA_PATH, 'videos')

  log('Cleaning up temp files in:', VIDEOS_PATH)

  const files = await readdir(VIDEOS_PATH)

  for (const file of files) {
    if (file.endsWith('.tmp')) {
      await unlink(join(VIDEOS_PATH, file))
      log('Removed file:', file)
    }
  }
}
