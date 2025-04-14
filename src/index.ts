import createDebug from 'debug'
import crypto from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import c from 'picocolors'
import { spawnSync as $ } from 'picospawn'
import { concat, isObject, isString } from 'radashi'

const debug = createDebug('subrepo-install')
const log = (msg: string) => console.log(c.magenta(c.italic(msg)))

export interface Subrepo {
  /**
   * Where to clone the sub-repo.
   */
  dir: string
  /**
   * The remote URL of the sub-repo.
   */
  remote: string
  /**
   * The branch, tag, or commit hash to clone. Branches and tags are synced
   * every time `subrepo-install` is used.
   *
   * For commit hashes, it's recommended to use the full hash instead of a short
   * commit hash.
   *
   * If undefined, the default branch will be used, except when the sub-repo has
   * already been cloned (in which case, the current HEAD ref will be used).
   */
  ref?: string
  /**
   * List of relative paths to packages within the sub-repo. This
   * ensures the `node_modules` of each package are installed and
   * their `build` script is executed.
   */
  packages?: string[]
  /**
   * What to do with the root package.
   *
   * - `ignore`: Do nothing with the root package.
   * - `install-only`: Install dependencies but don't build or link the root package.
   * - `default`: Treat the root package like any other package.
   */
  rootPackage?: 'ignore' | 'install-only' | 'default'
  /**
   * If a sub-repo exists elsewhere when in the context of a
   * workspace, you can link to this path instead of cloning.
   */
  workspaceOverride?: string
  /**
   * If a sub-repo has `node_modules` dependencies that you also want
   * in the `node_modules` of this repo, list them here.
   */
  inheritDependencies?: string[]
  /**
   * Create symlinks for files in the sub-repo to the root of this repo.
   */
  linkFiles?: Record<string, string>
}

export default function subrepoInstall(repos: Subrepo[]) {
  const isInWorkspace =
    $('pnpm root -w', {
      stdio: 'ignore',
      exit: false,
    }).status === 0

  const hasLockfile = (dir: string) =>
    existsSync(path.join(dir, 'pnpm-lock.yaml'))

  const isWorkspace = (dir: string) =>
    existsSync(path.join(dir, 'pnpm-workspace.yaml'))

  const metadataPath = '.cache/subrepo-install.json'
  const metadata = readJsonFile<Metadata>(metadataPath) ?? {}

  const oldHeads = metadata.heads
  const newHeads: typeof metadata.heads = {}

  for (const repo of repos) {
    if (isInWorkspace && repo.workspaceOverride) {
      ensureSymlink(repo.dir, repo.workspaceOverride)
      continue
    }

    let ref = repo.ref
    let head: string
    let shouldUpdate = true

    if (existsSync(repo.dir)) {
      ref ??= $('git -C %s rev-parse --abbrev-ref HEAD', [repo.dir], {
        stdio: 'pipe',
      })

      head = $('git -C %s rev-parse HEAD', [repo.dir], {
        stdio: 'pipe',
      })

      const expectedHead = isCommitHash(ref)
        ? ref
        : $('git -C %s ls-remote origin %s', [repo.dir, ref], {
            stdio: 'pipe',
          }).slice(0, 40)

      if (head === expectedHead) {
        shouldUpdate = false
      }

      if (shouldUpdate) {
        log(`Syncing ${formatRelative(repo.dir)} package...`)
      }
    } else {
      log(`Cloning ${formatRelative(repo.dir)} package...`)
      $('git clone --depth 1', [repo.remote, repo.dir])
    }

    if (shouldUpdate && ref) {
      debug(`Fetching ref: ${ref}`)
      $('git -C %s fetch --depth 1 origin %s', [repo.dir, ref])

      debug(`Resetting to FETCH_HEAD...`)
      $('git -C %s reset --hard FETCH_HEAD', [repo.dir])
    }

    head = $('git -C %s rev-parse HEAD', [repo.dir], {
      stdio: 'pipe',
    })

    const rootIsWorkspace = isWorkspace(repo.dir)
    const rootPackageStrategy = repo.rootPackage ?? 'default'
    const rootPackageId =
      rootPackageStrategy !== 'ignore' &&
      existsSync(path.join(repo.dir, 'package.json'))
        ? '.'
        : null

    for (const name of concat(rootPackageId, repo.packages)) {
      const packageDir = path.join(repo.dir, name)
      const isRootPackage = name === '.'
      const headChanged = head !== metadata.heads?.[packageDir]

      let shouldTrackHead = false

      if (isRootPackage || !isWorkspace(repo.dir)) {
        shouldTrackHead = true
        if (headChanged) {
          log(`Installing dependencies for ${packageDir}...`)
          $('pnpm -C %s install', [
            packageDir,
            // Avoid generating a lockfile if none exists yet.
            !hasLockfile(packageDir) && '--no-lockfile',
            // Avoid using a workspace unrelated to this clone.
            !rootIsWorkspace &&
              !isWorkspace(packageDir) &&
              '--ignore-workspace',
          ])
        }
      }

      if (!isRootPackage || rootPackageStrategy !== 'install-only') {
        const pkg = readPackageJson(packageDir)

        if (pkg?.scripts?.build) {
          shouldTrackHead = true
          if (headChanged) {
            log(`Building ${formatRelative(packageDir)}...`)
            $('pnpm -C %s run build', [packageDir])
          }
        }

        if (pkg?.name) {
          ensureSymlink(
            path.join(repo.dir, 'node_modules', pkg.name),
            packageDir
          )
        }
      }

      if (shouldTrackHead) {
        newHeads[packageDir] = head

        if (headChanged) {
          saveJsonFile(metadataPath, {
            ...oldHeads,
            ...newHeads,
          })
        } else {
          debug(`Nothing changed with ${formatRelative(packageDir)}`)
        }
      }
    }

    // Drop metadata for packages no longer in the repo.
    saveJsonFile(metadataPath, {
      ...metadata,
      heads: newHeads,
    })

    for (const name of repo.inheritDependencies ?? []) {
      const targetDir = path.join(repo.dir, 'node_modules', name)
      const targetPkg = readPackageJson(targetDir)
      if (!targetPkg) {
        continue
      }

      ensureSymlink(path.join('node_modules', name), targetDir)

      if (isString(targetPkg.bin)) {
        if (targetPkg.name) {
          ensureSymlink(
            path.join('node_modules/.bin', targetPkg.name),
            path.join(targetDir, targetPkg.bin)
          )
        }
      } else if (isObject(targetPkg.bin)) {
        for (const name in targetPkg.bin) {
          ensureSymlink(
            path.join('node_modules/.bin', name),
            path.join(targetDir, targetPkg.bin[name])
          )
        }
      }
    }

    for (const [from, to] of Object.entries(repo.linkFiles ?? {})) {
      ensureSymlink(from, path.join(repo.dir, to))
    }
  }
}

interface Metadata {
  /** The last seen commit hash for each package. */
  heads?: Record<string, string>
}

interface PackageJson extends Record<string, unknown> {
  name: string
  bin?: string | Record<string, string>
  scripts?: Record<string, string>
}

function readPackageJson(dir: string): PackageJson | null {
  return readJsonFile(path.join(dir, 'package.json'))
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch (error) {
    debug(`Error reading ${formatRelative(file)}: %s`, error)
    return null
  }
}

function saveJsonFile(file: string, data: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2))
}

function ensureSymlink(from: string, to: string) {
  if (debug.enabled) {
    debug(`Linking ${formatRelative(from)} to ${formatRelative(to)}`)
  }
  rmSync(from, { recursive: true, force: true })
  mkdirSync(path.dirname(from), { recursive: true })
  symlinkSync(path.relative(path.dirname(from), to), from)
}

function formatRelative(file: string) {
  file = path.posix.normalize(path.relative(process.cwd(), file))
  return file.startsWith('..') ? file : `./${file}`
}

function isCommitHash(ref: string) {
  return /^[0-9a-f]{40}$/.test(ref)
}

function md5Hash(str: string) {
  return crypto.createHash('md5').update(str).digest('hex')
}
