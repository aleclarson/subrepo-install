import createDebug from 'debug'
import { existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import c from 'picocolors'
import { spawnSync as $ } from 'picospawn'
import { isObject, isString } from 'radashi'

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
   * If a sub-repo exists elsewhere when in the context of a
   * workspace, you can link to this path instead of cloning.
   */
  workspaceDir?: string
  /**
   * If a sub-repo has `node_modules` dependencies that you also want
   * in the `node_modules` of this repo, list them here.
   */
  inheritDependencies?: string[]
  /**
   * Create symlinks for files in the sub-repo to the root of this repo.
   */
  linkFiles?: Record<string, string>
  /**
   * Skip the `build` script in the sub-repo's root `package.json`.
   */
  skipRootBuild?: boolean
}

export default function subrepoInstall(repos: Subrepo[]) {
  const isInWorkspace = $('pnpm root -w', { exit: false }).status === 0

  const hasLockfile = (dir: string) =>
    existsSync(path.join(dir, 'pnpm-lock.yaml'))

  const isWorkspace = (dir: string) =>
    existsSync(path.join(dir, 'pnpm-workspace.yaml'))

  for (const repo of repos) {
    if (isInWorkspace && repo.workspaceDir) {
      ensureSymlink(repo.dir, repo.workspaceDir)
      continue
    }

    let ref = repo.ref
    let shouldUpdate = true

    if (existsSync(repo.dir)) {
      ref ??= $('git -C %s rev-parse --abbrev-ref HEAD', [repo.dir], {
        stdio: 'pipe',
      })

      const currentHead = $('git -C %s rev-parse HEAD', [repo.dir], {
        stdio: 'pipe',
      })

      const desiredHead = isCommitHash(ref)
        ? ref
        : $('git -C %s ls-remote origin %s', [repo.dir, ref], {
            stdio: 'pipe',
          }).slice(0, 40)

      if (currentHead === desiredHead) {
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

    const repoIsWorkspace = isWorkspace(repo.dir)

    for (const name of ['', repo.packages].flat().filter(x => x != null)) {
      const packageDir = path.join(repo.dir, name)
      const isRootPackage = name === ''

      if (isRootPackage || !isWorkspace(repo.dir)) {
        log(`Installing dependencies for ${packageDir}...`)
        $('pnpm -C %s install', [
          packageDir,
          // Avoid generating a lockfile if none exists yet.
          !hasLockfile(packageDir) && '--no-lockfile',
          // Avoid using a workspace unrelated to this clone.
          !repoIsWorkspace && !isWorkspace(packageDir) && '--ignore-workspace',
        ])
      }

      if (!isRootPackage || !repo.skipRootBuild) {
        log(`Building ${packageDir} if needed...`)
        $('pnpm -C %s run --if-present build', [packageDir])
      }
    }

    for (const name of repo.inheritDependencies ?? []) {
      const targetDir = path.join(repo.dir, 'node_modules', name)
      const targetPkg = readPackageJson(targetDir)

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

interface PackageJson extends Record<string, unknown> {
  name: string
  bin?: string | Record<string, string>
}

function readPackageJson(dir: string): PackageJson {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8'))
}

function ensureSymlink(from: string, to: string) {
  if (debug.enabled) {
    debug(`Linking ${formatRelative(from)} to ${formatRelative(to)}`)
  }
  rmSync(from, { force: true })
  symlinkSync(path.relative(path.dirname(from), to), from)
}

function formatRelative(file: string) {
  file = path.posix.normalize(path.relative(process.cwd(), file))
  return file.startsWith('..') ? file : `./${file}`
}

function isCommitHash(ref: string) {
  return /^[0-9a-f]{40}$/.test(ref)
}
