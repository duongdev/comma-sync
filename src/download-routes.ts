import { createWriteStream } from 'node:fs'
import { readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import axios from 'axios'
import { config } from './config'
import { getDB, saveDB } from './db'
import { sleep } from './utils'

const debug = require('debug')('comma-sync:routes')

export async function downloadRoutes() {
  const log = debug.extend('downloadRoutes')

  try {
    const routes = await getRoutes()

    for (const routeId of routes) {
      log('Uploading route:', routeId)
      await downloadRouteVideos(routeId)
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
  const log = debug.extend(`uploadRoute:${routeId}`)

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

    const response = await axios.get(videoUrl, { responseType: 'stream' })
    const FILE_NAME = `${routeId}-${camera}.mp4`
    const VIDEOS_PATH = join(config.DATA_PATH, 'videos')

    const writeStream = createWriteStream(join(VIDEOS_PATH, `${FILE_NAME}.tmp`))

    response.data.pipe(writeStream)

    await new Promise((resolve) => {
      writeStream.on('finish', resolve)
    })

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
