import { accessSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import debug from 'debug'

const log = debug('comma-sync:fs')

export function verifyPath(...paths: string[]) {
  const path = join(...paths)
  try {
    accessSync(path)
  } catch {
    const l = log.extend('verifyPath')
    l('Path does not exist. Creating...', path)
    mkdirSync(path, { recursive: true })
  }

  return path
}
