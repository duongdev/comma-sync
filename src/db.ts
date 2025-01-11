import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { config } from './config'

const debug = require('debug')('comma-sync:db')

const { DB_PATH } = config

const DEFAULT_DB = {
  version: 1,
  routes: {} as Record<
    string,
    {
      routeId: string
      cameras: Record<
        string,
        {
          downloadedAt?: string
          telegram?: { uploadedChunks?: number }
        }
      >
    }
  >,
}

export type Database = typeof DEFAULT_DB

export async function verifyDBFile() {
  try {
    await access(DB_PATH)
  } catch {
    debug('Database file does not exist, creating:', DB_PATH)
    mkdir(config.DATA_PATH, { recursive: true })
    await writeFile(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2), 'utf8')
  }
}

export async function getDB(): Promise<Database> {
  try {
    await verifyDBFile()
    const db = JSON.parse(await readFile(DB_PATH, 'utf8')) as Database
    return db
  } catch (error) {
    debug('Unable to load database:', error)
    await saveDB(DEFAULT_DB)
    return DEFAULT_DB
  }
}

export async function saveDB(db: Database): Promise<Database> {
  await verifyDBFile()
  await writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf8')

  return db
}
